// The upload router fences one writer without rejecting or replaying uploads.
// Requests already assigned locally finish there; later requests are forwarded
// synchronously to the verified replacement. Only root can change the target.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type state struct {
	Mode         string `json:"mode"`
	Epoch        uint64 `json:"epoch"`
	MFSReady     bool   `json:"mfsReady"`
	Target       string `json:"target,omitempty"`
	TargetNodeID string `json:"targetNodeId,omitempty"`
	Certificate  string `json:"certificate,omitempty"`
}

type router struct {
	mu           sync.Mutex
	state        state
	local        *httputil.ReverseProxy
	remote       *httputil.ReverseProxy
	localActive  int
	remoteActive int
	path         string
	nodeID       string
	source       string
	changed      chan struct{}
	waitingMFS   int
}

func proxy(target *url.URL, transport http.RoundTripper, forwarded bool) *httputil.ReverseProxy {
	p := httputil.NewSingleHostReverseProxy(target)
	p.Transport = transport
	p.ErrorLog = log.New(io.Discard, "", 0)
	p.FlushInterval = -1
	director := p.Director
	p.Director = func(r *http.Request) {
		director(r)
		if forwarded {
			r.Host = "api-ipfs.6529.io"
			r.Header.Set("X-6529-IPFS-Hop", "1")
		}
	}
	p.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "IPFS upstream unavailable", http.StatusBadGateway)
	}
	return p
}

func remoteProxy(s state, nodeID string) (*httputil.ReverseProxy, error) {
	if s.Mode == "serve" {
		if s.Target != "" || s.TargetNodeID != "" || s.Certificate != "" {
			return nil, errors.New("serve state cannot contain a target")
		}
		return nil, nil
	}
	if s.Mode != "forward" || s.TargetNodeID == "" || s.TargetNodeID == nodeID {
		return nil, errors.New("invalid forwarding identity")
	}
	u, err := url.Parse(s.Target)
	if err != nil || u.Scheme != "https" || u.Port() == "" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("target must be an explicit private HTTPS address")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsPrivate() || ip.To4() == nil {
		return nil, errors.New("target must use a private IPv4 address")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(s.Certificate)) {
		return nil, errors.New("target certificate is required")
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "api-ipfs.6529.io", MinVersion: tls.VersionTLS12}
	return proxy(u, t, true), nil
}

func persist(path string, s state) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".router-state-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(0600); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (r *router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/api/v0/add" || (req.Method != http.MethodPost && req.Method != http.MethodOptions) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	mfsWrite := false
	for _, value := range req.URL.Query()["to-files"] {
		mfsWrite = mfsWrite || value != ""
	}
	r.mu.Lock()
	// Immutable adds can continue during the final pin union. Mutable Files API
	// adds wait synchronously until the last source MFS root has been installed.
	// They have not reached Kubo and cannot change the destination baseline.
	for mfsWrite && r.state.Mode == "serve" && !r.state.MFSReady {
		change := r.changed
		r.waitingMFS++
		r.mu.Unlock()
		select {
		case <-req.Context().Done():
			r.mu.Lock()
			r.waitingMFS--
			r.mu.Unlock()
			return
		case <-change:
		}
		r.mu.Lock()
		r.waitingMFS--
	}
	forward := r.state.Mode == "forward"
	p := r.local
	if forward {
		if req.Header.Get("X-6529-IPFS-Hop") != "" {
			r.mu.Unlock()
			http.Error(w, "Forwarding cycle refused", http.StatusBadGateway)
			return
		}
		p = r.remote
		r.remoteActive++
	} else {
		r.localActive++
	}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if forward {
			r.remoteActive--
		} else {
			r.localActive--
		}
	}()
	p.ServeHTTP(w, req)
}

func (r *router) control(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if req.URL.Path != "/state" {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	if req.Method == http.MethodPost {
		var input struct {
			ExpectedEpoch uint64 `json:"expectedEpoch"`
			State         state  `json:"state"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 16384))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil {
			http.Error(w, "Invalid state", http.StatusBadRequest)
			return
		}
		p, err := remoteProxy(input.State, r.nodeID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		r.mu.Lock()
		if input.ExpectedEpoch != r.state.Epoch || input.State.Epoch != r.state.Epoch+1 {
			r.mu.Unlock()
			http.Error(w, "State changed; reconcile before retrying", http.StatusConflict)
			return
		}
		if err = persist(r.path, input.State); err != nil {
			r.mu.Unlock()
			http.Error(w, "State was not persisted", http.StatusInternalServerError)
			return
		}
		r.state, r.remote = input.State, p
		close(r.changed)
		r.changed = make(chan struct{})
		r.mu.Unlock()
	} else if req.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{
		"mode": r.state.Mode, "epoch": r.state.Epoch, "targetNodeId": r.state.TargetNodeID,
		"nodeId": r.nodeID, "sourceSha": r.source,
		"localActive": r.localActive, "forwardActive": r.remoteActive,
		"mfsReady": r.state.MFSReady, "waitingMfs": r.waitingMFS,
	})
}

func main() {
	listen := flag.String("listen", "127.0.0.1:9080", "loopback upload address")
	upstream := flag.String("upstream", "http://127.0.0.1:5001", "local Kubo RPC address")
	control := flag.String("control", "/run/6529-ipfs-router/control.sock", "root-only Unix control socket")
	path := flag.String("state", "/etc/6529-ipfs/router-state.json", "persistent routing state")
	node := flag.String("node-id", "", "EC2 instance identity")
	source := flag.String("source-sha", "", "reviewed release SHA")
	flag.Parse()
	if !strings.HasPrefix(*listen, "127.0.0.1:") || *node == "" || len(*source) != 40 {
		log.Fatal("Explicit node/source identity and loopback listener required")
	}
	data, err := os.ReadFile(*path)
	if err != nil {
		log.Fatal("Persistent initial state required")
	}
	r := &router{path: *path, nodeID: *node, source: *source, changed: make(chan struct{})}
	if json.Unmarshal(data, &r.state) != nil {
		log.Fatal("Invalid persisted state")
	}
	r.remote, err = remoteProxy(r.state, *node)
	if err != nil {
		log.Fatal(err)
	}
	u, err := url.Parse(*upstream)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "" || u.User != nil || u.RawQuery != "" {
		log.Fatal("Kubo upstream must be an explicit loopback address")
	}
	r.local = proxy(u, http.DefaultTransport, false)
	if err = os.MkdirAll(filepath.Dir(*control), 0700); err != nil {
		log.Fatal(err)
	}
	if err = os.Remove(*control); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatal(err)
	}
	socket, err := net.Listen("unix", *control)
	if err != nil {
		log.Fatal(err)
	}
	if err = os.Chmod(*control, 0600); err != nil {
		log.Fatal(err)
	}
	go func() {
		s := &http.Server{Handler: http.HandlerFunc(r.control), ReadHeaderTimeout: 5 * time.Second}
		log.Fatal(s.Serve(socket))
	}()
	s := &http.Server{Addr: *listen, Handler: r, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 65 * time.Second}
	fmt.Println("IPFS upload router ready")
	log.Fatal(s.ListenAndServe())
}
