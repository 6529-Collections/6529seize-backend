import { parseGainMapXmp, serializeGainMapXmp } from './gain-map-xmp';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const HDRGM = 'http://ns.adobe.com/hdr-gain-map/1.0/';

function packet(body: string, namespaces = ''): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">` +
      `<rdf:Description rdf:about=""${namespaces}>${body}</rdf:Description>` +
      '</rdf:RDF></x:xmpmeta>',
    'utf8'
  );
}

function keptValues(xmp: Buffer) {
  return parseGainMapXmp(xmp)!.properties.map(
    (property) =>
      `${property.spec.prefix}:${property.spec.name}=${property.value}`
  );
}

describe('parseGainMapXmp', () => {
  it('reads gain map values whatever the prefix or RDF spelling', () => {
    const xmp = packet(
      '<g:Version>1.0</g:Version>' +
        '<g:GainMapMax rdf:parseType="Resource"></g:GainMapMax>' +
        '<g:HDRCapacityMax>&#50;.5</g:HDRCapacityMax>' +
        '<g:Gamma><rdf:Seq><rdf:li>1</rdf:li><rdf:li>1.1</rdf:li>' +
        '<rdf:li>1.2</rdf:li></rdf:Seq></g:Gamma>',
      ` xmlns:g="${HDRGM}"`
    );
    expect(keptValues(xmp)).toEqual([
      'hdrgm:Version=1.0',
      'hdrgm:Gamma=1,1.1,1.2',
      'hdrgm:HDRCapacityMax=2.5'
    ]);
  });

  it('keeps only allowlisted properties with numeric, boolean or fixed values', () => {
    const xmp = packet(
      '<hdrgm:Comment>Jane Synthetic</hdrgm:Comment>' +
        '<hdrgm:Gamma><rdf:Seq><rdf:li>1</rdf:li><rdf:li>2</rdf:li></rdf:Seq></hdrgm:Gamma>' +
        '<apdi:AuxiliaryImageType>urn:com:apple:photo:2018:aux:portraiteffectsmatte</apdi:AuxiliaryImageType>' +
        '<HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion>',
      ` xmlns:hdrgm="${HDRGM}" hdrgm:Version="1.0 Jane" hdrgm:GainMapMin="-1e2"` +
        ' hdrgm:BaseRenditionIsHDR="maybe"' +
        ' xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/"' +
        ' xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"'
    );
    expect(keptValues(xmp)).toEqual([
      'hdrgm:GainMapMin=-1e2',
      'HDRGainMap:HDRGainMapVersion=65536'
    ]);
  });

  it('reads container items in attribute, element and description form', () => {
    const xmp = packet(
      '<C:Directory><rdf:Seq>' +
        '<rdf:li rdf:parseType="Resource"><C:Item I:Semantic="Primary" I:Mime="image/jpeg" I:Padding="4"/></rdf:li>' +
        '<rdf:li><C:Item rdf:parseType="Resource"><I:Semantic>GainMap</I:Semantic><I:Length>10</I:Length></C:Item></rdf:li>' +
        '<rdf:li><rdf:Description><C:Item><rdf:Description I:Semantic="MotionPhoto" I:Mime="video/mp4" I:Length="20"/></C:Item></rdf:Description></rdf:li>' +
        '</rdf:Seq></C:Directory>',
      ' xmlns:C="http://ns.google.com/photos/1.0/container/"' +
        ' xmlns:I="http://ns.google.com/photos/1.0/container/item/"'
    );
    expect(parseGainMapXmp(xmp)).toEqual({
      properties: [],
      directory: [
        {
          semantic: 'Primary',
          mime: 'image/jpeg',
          length: undefined,
          padding: 4
        },
        { semantic: 'GainMap', mime: '', length: 10, padding: 0 },
        { semantic: 'MotionPhoto', mime: 'video/mp4', length: 20, padding: 0 }
      ],
      directoryMalformed: false
    });
  });

  it('marks a directory with an unreadable length as malformed', () => {
    const xmp = packet(
      '<C:Directory><rdf:Seq><rdf:li rdf:parseType="Resource">' +
        '<C:Item I:Semantic="GainMap" I:Length="ten"/></rdf:li></rdf:Seq></C:Directory>',
      ' xmlns:C="http://ns.google.com/photos/1.0/container/"' +
        ' xmlns:I="http://ns.google.com/photos/1.0/container/item/"'
    );
    expect(parseGainMapXmp(xmp)).toMatchObject({
      directory: null,
      directoryMalformed: true
    });
  });

  it.each([
    [
      'a DOCTYPE with entities',
      `<!DOCTYPE x [<!ENTITY e "1.0">]><x:xmpmeta xmlns:x="adobe:ns:meta/"/>`
    ],
    ['an unknown entity', packet('<hdrgm:Version>&e;</hdrgm:Version>')],
    [
      'mismatched tags',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><a></b></x:xmpmeta>'
    ],
    ['an unterminated element', '<x:xmpmeta xmlns:x="adobe:ns:meta/"><a>'],
    ['two root elements', '<a/><b/>'],
    ['deep nesting', `${'<a>'.repeat(40)}${'</a>'.repeat(40)}`]
  ])('refuses %s', (_, xml) => {
    expect(parseGainMapXmp(Buffer.from(xml))).toBeNull();
  });

  it('round-trips its own output byte for byte', () => {
    const original = packet(
      '<hdrgm:GainMapMax><rdf:Seq><rdf:li>2</rdf:li><rdf:li>3</rdf:li><rdf:li>4</rdf:li></rdf:Seq></hdrgm:GainMapMax>',
      ` xmlns:hdrgm="${HDRGM}" hdrgm:Version="1.0" hdrgm:HDRCapacityMax="2"`
    );
    const parsed = parseGainMapXmp(original)!;
    const written = serializeGainMapXmp(parsed.properties, [
      { semantic: 'Primary' },
      { semantic: 'GainMap', length: 99 }
    ])!;
    const xmpId = 'http://ns.adobe.com/xap/1.0/\0';
    expect(written.toString('latin1', 0, xmpId.length)).toBe(xmpId);
    const reparsed = parseGainMapXmp(written.subarray(xmpId.length))!;
    expect(reparsed.properties).toEqual(parsed.properties);
    expect(reparsed.directory).toEqual([
      {
        semantic: 'Primary',
        mime: 'image/jpeg',
        length: undefined,
        padding: 0
      },
      { semantic: 'GainMap', mime: 'image/jpeg', length: 99, padding: 0 }
    ]);
    expect(
      serializeGainMapXmp(reparsed.properties, [
        { semantic: 'Primary' },
        { semantic: 'GainMap', length: 99 }
      ])
    ).toEqual(written);
  });

  it('writes nothing when there is nothing to keep', () => {
    expect(serializeGainMapXmp([], null)).toBeNull();
  });
});
