import {
  CA_SEMA_XML_PARSER_ID,
  parseCaSemaXml
} from '@/sanctions/parsers/ca-sema-xml.parser';
import {
  CH_SECO_XML_PARSER_ID,
  parseChSecoXml
} from '@/sanctions/parsers/ch-seco-xml.parser';
import {
  EU_FSF_XML_PARSER_ID,
  parseEuFsfXml
} from '@/sanctions/parsers/eu-fsf-xml.parser';
import {
  IL_NBCTF_API_PARSER_ID,
  parseIlNbctfApi
} from '@/sanctions/parsers/il-nbctf-api.parser';
import {
  JP_MOF_CSV_PARSER_ID,
  parseJpMofCsv
} from '@/sanctions/parsers/jp-mof-csv.parser';
import {
  KR_FSC_PINNED_PARSER_ID,
  parseKrFscPinned
} from '@/sanctions/parsers/kr-fsc-pinned.parser';
import {
  OFAC_SDN_XML_PARSER_ID,
  parseOfacSdnXml
} from '@/sanctions/parsers/ofac-sdn-xml.parser';
import {
  parseUkFcdoXml,
  UK_FCDO_XML_PARSER_ID
} from '@/sanctions/parsers/uk-fcdo-xml.parser';
import type { SanctionsSourceParser } from '@/sanctions/parsers/sanctions-parser.types';
import type {
  SanctionsAcquisition,
  SanctionsSourceId,
  SanctionsSourceNature
} from '@/sanctions/sanctions-list.types';

export interface SanctionsSourceDefinition {
  readonly id: SanctionsSourceId;
  readonly authority: string;
  readonly jurisdiction: string;
  readonly list_name: string;
  readonly nature: SanctionsSourceNature;
  /** Where people can find the official list (also the primary download where stable). */
  readonly url: string;
  readonly acquisition: SanctionsAcquisition;
  readonly parser: string;
  readonly parse: SanctionsSourceParser;
}

/**
 * The official sources the list is built from, sorted by id. Changing any
 * field here changes the artifact, so it is part of the spec version.
 */
export const SANCTIONS_SOURCES: ReadonlyArray<SanctionsSourceDefinition> = [
  {
    id: 'ca-sema',
    authority: 'Global Affairs Canada',
    jurisdiction: 'CA',
    list_name: 'Consolidated Canadian Autonomous Sanctions List',
    nature: 'sanctions_designation',
    url: 'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml',
    acquisition: 'automatic',
    parser: CA_SEMA_XML_PARSER_ID,
    parse: parseCaSemaXml
  },
  {
    id: 'ch-seco',
    authority: 'State Secretariat for Economic Affairs (SECO)',
    jurisdiction: 'CH',
    list_name: 'Swiss consolidated sanctions list',
    nature: 'sanctions_designation',
    url: 'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction',
    acquisition: 'automatic',
    parser: CH_SECO_XML_PARSER_ID,
    parse: parseChSecoXml
  },
  {
    id: 'eu-fsf',
    authority: 'European Commission',
    jurisdiction: 'EU',
    list_name:
      'Consolidated list of persons, groups and entities subject to EU financial sanctions',
    nature: 'sanctions_designation',
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
    acquisition: 'automatic',
    parser: EU_FSF_XML_PARSER_ID,
    parse: parseEuFsfXml
  },
  {
    id: 'il-nbctf',
    authority:
      'National Bureau for Counter Terror Financing, Israel Ministry of Defense',
    jurisdiction: 'IL',
    list_name: 'Cryptocurrency seizure and forfeiture orders',
    nature: 'seizure_order',
    url: 'https://matal.mod.gov.il/umbraco/delivery/api/v2/content?filter=contentType:cryptocurrencyWallet',
    acquisition: 'automatic',
    parser: IL_NBCTF_API_PARSER_ID,
    parse: parseIlNbctfApi
  },
  {
    id: 'jp-mof',
    authority: 'Ministry of Finance, Japan',
    jurisdiction: 'JP',
    list_name: 'List of persons subject to asset freeze measures',
    nature: 'sanctions_designation',
    url: 'https://www.mof.go.jp/policy/international_policy/gaitame_kawase/gaitame/economic_sanctions/list.html',
    acquisition: 'automatic',
    parser: JP_MOF_CSV_PARSER_ID,
    parse: parseJpMofCsv
  },
  {
    id: 'kr-fsc',
    authority:
      'Financial Services Commission and Korea Financial Intelligence Unit',
    jurisdiction: 'KR',
    list_name:
      'Persons subject to financial transaction restrictions (FSC notice annex)',
    nature: 'sanctions_designation',
    url: 'https://www.law.go.kr/LSW/flDownload.do?flSeq=160993933',
    acquisition: 'pinned_manual',
    parser: KR_FSC_PINNED_PARSER_ID,
    parse: parseKrFscPinned
  },
  {
    id: 'uk-fcdo',
    authority: 'Foreign, Commonwealth and Development Office',
    jurisdiction: 'GB',
    list_name: 'UK Sanctions List',
    nature: 'sanctions_designation',
    url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
    acquisition: 'automatic',
    parser: UK_FCDO_XML_PARSER_ID,
    parse: parseUkFcdoXml
  },
  {
    id: 'us-ofac-sdn',
    authority:
      'U.S. Department of the Treasury, Office of Foreign Assets Control',
    jurisdiction: 'US',
    list_name: 'Specially Designated Nationals and Blocked Persons List',
    nature: 'sanctions_designation',
    url: 'https://sanctionslistservice.ofac.treas.gov/api/download/SDN.XML',
    acquisition: 'automatic',
    parser: OFAC_SDN_XML_PARSER_ID,
    parse: parseOfacSdnXml
  }
];

export function getSanctionsSource(
  id: SanctionsSourceId
): SanctionsSourceDefinition {
  for (const source of SANCTIONS_SOURCES) {
    if (source.id === id) {
      return source;
    }
  }
  throw new Error(`Unknown sanctions source ${id}`);
}
