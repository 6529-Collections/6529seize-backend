import { buildLido } from './lido';
import { lidoFixture } from './lido-fixture';

const records = (xml: string) =>
  xml
    .split('<lido:lido>')
    .slice(1)
    .map((part) => part.split('</lido:lido>')[0]);
const recordFor = (xml: string, id: string) =>
  records(xml).find((part) =>
    part.includes(
      `<lido:objectPublishedID lido:type="URI">urn:uuid:${id}</lido:objectPublishedID>`
    )
  )!;
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('LIDO museum descriptive interchange', () => {
  it('keeps image-area, sheet and file measurements attached to their actual subjects', () => {
    const xml = buildLido(lidoFixture());
    const print = recordFor(xml, id(4));
    const file = recordFor(xml, id(3));
    const work = recordFor(xml, id(2));
    expect(print).toContain(
      '<lido:extentMeasurements>image</lido:extentMeasurements>'
    );
    expect(print).toContain(
      '<lido:measurementValue>120</lido:measurementValue>'
    );
    expect(print).toContain(
      '<lido:extentMeasurements>sheet</lido:extentMeasurements>'
    );
    expect(print).toContain(
      '<lido:measurementValue>140</lido:measurementValue>'
    );
    expect(print).toContain(
      '<lido:qualifierMeasurements>approximate</lido:qualifierMeasurements>'
    );
    expect(print).not.toContain(
      '<lido:measurementUnit>px</lido:measurementUnit>'
    );
    expect(file).toContain(
      '<lido:extentMeasurements>digital_file</lido:extentMeasurements>'
    );
    expect(file).toContain(
      '<lido:measurementValue>6000</lido:measurementValue>'
    );
    expect(work).not.toContain('<lido:objectMeasurementsWrap>');
  });
  it('separates depicted geography from event location without promoting authority proposals', () => {
    const xml = buildLido(lidoFixture());
    expect(xml).toContain(
      '<lido:appellationValue xml:lang="el">Μήλος</lido:appellationValue>'
    );
    expect(xml).toContain(
      '<lido:displayPlace xml:lang="el">Μήλος (uncertain); Artist-supplied location.</lido:displayPlace>'
    );
    const eventPlaces = xml
      .split('<lido:eventPlace')
      .slice(1)
      .map((part) => part.split('</lido:eventPlace>')[0]);
    expect(eventPlaces).toHaveLength(1);
    expect(eventPlaces[0]).toContain('Studio');
    expect(eventPlaces[0]).not.toContain('Μήλος');
    expect(xml).not.toContain('http://vocab.getty.edu/tgn/123');
    expect(xml).not.toContain('repositoryLocation');
  });
  it('preserves event identity, actor role, original writing and approximate date precision', () => {
    const xml = buildLido(lidoFixture());
    expect(xml).toContain('<lido:term>photographer</lido:term>');
    expect(xml).toContain('<lido:earliestDate>2026-05-18</lido:earliestDate>');
    const completion = xml
      .split('<lido:eventSet>')
      .slice(1)
      .find((part) => part.includes('Final image'))!
      .split('</lido:eventSet>')[0];
    expect(completion).toContain('approximately 2026-05');
    expect(completion).not.toContain('<lido:earliestDate>');
    expect(xml).toContain(
      'The image contains &lt;a gate&gt; &amp; water.\nA second paragraph.'
    );
    expect(recordFor(xml, id(2))).not.toContain('Unreviewed machine words.');
    expect(recordFor(xml, id(27))).toContain(
      'lido:type="unreviewed_machine_transcript"'
    );
    expect(xml).toContain('Test Artist (artist)');
    expect(xml).toContain(
      '<lido:descriptiveNoteValue xml:lang="el">Το κατώφλι.</lido:descriptiveNoteValue>'
    );
    expect(xml).not.toContain('[object Object]');
    expect(xml).not.toContain('acquisition');
  });
});
