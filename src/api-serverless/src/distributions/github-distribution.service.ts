import fetch, { RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { env } from '../../../env';
import { Logger } from '../../../logging';

interface PhotoUpload {
  fileName: string;
  content: Buffer;
}

interface PhaseCsvFiles {
  phaseIndex: number;
  phaseName: string;
  airdropsCsv: string;
  allowlistsCsv: string;
}

interface GitHubFileInfo {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
}

const API_BASE = 'https://api.github.com/repos';

export class GitHubDistributionService {
  private readonly logger = Logger.get(this.constructor.name);
  private readonly owner = '6529-Collections';
  private readonly repo = 'thememecards';
  private readonly branch = 'main';

  private getToken(): string {
    return env.getStringOrThrow('GH_MEMECARDS_TOKEN');
  }

  private getCommitterInfo() {
    const name =
      env.getStringOrNull('GH_MEMECARDS_COMMITTER_NAME') ??
      '6529 Distribution Bot';
    const email =
      env.getStringOrNull('GH_MEMECARDS_COMMITTER_EMAIL') ??
      'distribution@6529.io';
    const date = new Date().toISOString();
    return { name, email, date };
  }

  private api(path: string, options: NodeFetchRequestInit = {}) {
    const token = this.getToken();
    const extraHeaders =
      options.headers &&
      typeof options.headers === 'object' &&
      !Array.isArray(options.headers) &&
      !(options.headers instanceof Headers)
        ? (options.headers as Record<string, string>)
        : {};
    const init: NodeFetchRequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...extraHeaders
      }
    };
    return fetch(`${API_BASE}/${this.owner}/${this.repo}${path}`, init);
  }

  async uploadDistributionFiles(
    cardId: number,
    photos: PhotoUpload[],
    airdropFinalCsv: string,
    phaseCsvFiles: PhaseCsvFiles[]
  ): Promise<{ uploadedFiles: string[]; deletedFiles: string[] }> {
    const folderPath = `card${cardId}`;
    const existingFiles = await this.listFolderContents(folderPath);
    const deletedFiles = existingFiles
      .filter((f) => f.type === 'file')
      .map((f) => f.path);

    const treeEntries: { path: string; content: Buffer }[] = [];
    for (const photo of photos) {
      treeEntries.push({
        path: photo.fileName,
        content: photo.content
      });
    }
    treeEntries.push({
      path: 'airdrop_final.csv',
      content: Buffer.from(airdropFinalCsv)
    });
    for (const phaseCsv of phaseCsvFiles) {
      if (phaseCsv.airdropsCsv.length > 0) {
        treeEntries.push({
          path: `phase_${phaseCsv.phaseIndex}_airdrops.csv`,
          content: Buffer.from(phaseCsv.airdropsCsv)
        });
      }
      if (phaseCsv.allowlistsCsv.length > 0) {
        treeEntries.push({
          path: `phase_${phaseCsv.phaseIndex}_allowlists.csv`,
          content: Buffer.from(phaseCsv.allowlistsCsv)
        });
      }
    }

    const committer = this.getCommitterInfo();
    const refResp = await this.api(`/git/refs/heads/${this.branch}`);
    if (!refResp.ok) {
      throw new Error(
        `Failed to get ref: ${refResp.status} - ${await refResp.text()}`
      );
    }
    const refData = (await refResp.json()) as { object: { sha: string } };
    const commitSha = refData.object.sha;

    const commitResp = await this.api(`/git/commits/${commitSha}`);
    if (!commitResp.ok) {
      throw new Error(
        `Failed to get commit: ${commitResp.status} - ${await commitResp.text()}`
      );
    }
    const commitData = (await commitResp.json()) as { tree: { sha: string } };
    const rootTreeSha = commitData.tree.sha;

    const blobShas: { path: string; sha: string }[] = [];
    for (const entry of treeEntries) {
      const blobResp = await this.api('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({
          content: entry.content.toString('base64'),
          encoding: 'base64'
        })
      });
      if (!blobResp.ok) {
        throw new Error(
          `Failed to create blob ${entry.path}: ${blobResp.status} - ${await blobResp.text()}`
        );
      }
      const blobData = (await blobResp.json()) as { sha: string };
      blobShas.push({ path: entry.path, sha: blobData.sha });
    }

    const cardTreeBody = {
      tree: blobShas.map(({ path, sha }) => ({
        path,
        mode: '100644',
        type: 'blob' as const,
        sha
      }))
    };
    const cardTreeResp = await this.api('/git/trees', {
      method: 'POST',
      body: JSON.stringify(cardTreeBody)
    });
    if (!cardTreeResp.ok) {
      throw new Error(
        `Failed to create tree for ${folderPath}: ${cardTreeResp.status} - ${await cardTreeResp.text()}`
      );
    }
    const cardTreeData = (await cardTreeResp.json()) as { sha: string };
    const cardTreeSha = cardTreeData.sha;

    const rootTreeBody = {
      base_tree: rootTreeSha,
      tree: [
        {
          path: folderPath,
          mode: '040000',
          type: 'tree' as const,
          sha: cardTreeSha
        }
      ]
    };
    const rootTreeResp = await this.api('/git/trees', {
      method: 'POST',
      body: JSON.stringify(rootTreeBody)
    });
    if (!rootTreeResp.ok) {
      throw new Error(
        `Failed to create root tree: ${rootTreeResp.status} - ${await rootTreeResp.text()}`
      );
    }
    const newRootTreeData = (await rootTreeResp.json()) as { sha: string };

    const commitMessage = `Card ${cardId} Distribution`;
    const newCommitBody = {
      message: commitMessage,
      tree: newRootTreeData.sha,
      parents: [commitSha],
      author: committer,
      committer
    };
    const newCommitResp = await this.api('/git/commits', {
      method: 'POST',
      body: JSON.stringify(newCommitBody)
    });
    if (!newCommitResp.ok) {
      throw new Error(
        `Failed to create commit: ${newCommitResp.status} - ${await newCommitResp.text()}`
      );
    }
    const newCommitData = (await newCommitResp.json()) as { sha: string };

    const updateRefResp = await this.api(`/git/refs/heads/${this.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitData.sha })
    });
    if (!updateRefResp.ok) {
      throw new Error(
        `Failed to update ref: ${updateRefResp.status} - ${await updateRefResp.text()}`
      );
    }

    const uploadedFiles = treeEntries.map((e) => `${folderPath}/${e.path}`);
    this.logger.info(
      `Single commit for card ${cardId}: ${uploadedFiles.length} files`
    );
    return { uploadedFiles, deletedFiles };
  }

  private async listFolderContents(
    folderPath: string
  ): Promise<GitHubFileInfo[]> {
    const contentResp = await this.api(
      `/contents/${folderPath}?ref=${this.branch}`
    );

    if (contentResp.status === 404) {
      this.logger.info(`Folder ${folderPath} does not exist yet`);
      return [];
    }

    if (!contentResp.ok) {
      const errorText = await contentResp.text();
      throw new Error(
        `Failed to list folder ${folderPath}: ${contentResp.status} - ${errorText}`
      );
    }

    const contents = (await contentResp.json()) as GitHubFileInfo[];
    return contents;
  }
}

export const githubDistributionService = new GitHubDistributionService();
