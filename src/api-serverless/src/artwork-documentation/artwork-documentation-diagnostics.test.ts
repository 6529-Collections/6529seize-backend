import {
  applyOperations,
  getProfile
} from '@/artwork-documentation/artwork-documentation.catalogue';
import { Answer } from '@/artwork-documentation/artwork-documentation.types';
import {
  documentationValidationField,
  fail,
  withDocumentationValidationField
} from '@/artwork-documentation/artwork-documentation.validation';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import { loggerContext, LoggerContextValue } from '@/logger-context';
import { Logger } from '@/logging';
import { logDocumentationModuleRejection } from './artwork-documentation-diagnostics';

const privateMarker = 'PRIVATE_ARTIST_TEXT_FILENAME_URL_OR_ID';
const correlation = '5b8bd8cf-85fd-4373-8ac6-739a5c3f749a';
const answer = (value: Answer['value']): Answer => ({
  status: 'provided',
  intended_visibility: 'public_record',
  value
});
function rejected(operation: () => unknown): ApiCompliantException {
  try {
    operation();
  } catch (error) {
    if (error instanceof ApiCompliantException) return error;
    throw error;
  }
  throw new Error('Expected validation rejection');
}

describe('documentation module rejection diagnostics', () => {
  const entries: { message: unknown; context?: LoggerContextValue }[] = [];
  let warn: jest.SpyInstance;
  beforeEach(() => {
    entries.length = 0;
    warn = jest
      .spyOn(Logger.get('ARTWORK_DOCUMENTATION_VALIDATION'), 'warn')
      .mockImplementation((message) => {
        entries.push({ message, context: loggerContext.get() });
      });
  });
  afterEach(() => jest.restoreAllMocks());

  it('records only allowlisted operation IDs and the actual rejected field', () => {
    const operations = [
      { op: 'set' as const, field: 'title', answer: answer(privateMarker) },
      {
        op: 'set' as const,
        field: 'declared_dimensions',
        answer: answer({ width: 0, height: 100 })
      }
    ];
    const failure = rejected(() => applyOperations('artwork', {}, operations));
    loggerContext.run({ requestId: correlation, jwtSub: privateMarker }, () => {
      logDocumentationModuleRejection(
        'artwork',
        { operations, token: privateMarker },
        failure
      );
      expect(loggerContext.get()).toEqual({
        requestId: correlation,
        jwtSub: privateMarker
      });
    });
    expect(entries).toEqual([
      {
        context: { requestId: correlation },
        message: {
          event: 'documentation_module_validation_rejected',
          operation: 'patch_module',
          module: 'artwork',
          status: 422,
          code: 'INVALID_VALUE',
          operation_fields: [
            { operation: 'set', field: 'declared_dimensions' },
            { operation: 'set', field: 'title' }
          ],
          rejected_field: { module: 'artwork', field: 'declared_dimensions' }
        }
      }
    ]);
    expect(JSON.stringify(entries)).not.toContain(privateMarker);
  });

  it('attributes invalid saved siblings without falsely blaming the edited field', () => {
    const profile = getProfile('photography_documentation_v1', 2);
    const operations = [
      { op: 'set' as const, field: 'title', answer: answer('New title') }
    ];
    const failure = rejected(() =>
      applyOperations(
        'artwork',
        { declared_dimensions: answer({ width: 0, height: 100 }) },
        operations,
        profile
      )
    );
    logDocumentationModuleRejection('artwork', { operations }, failure);
    expect(entries[0].message).toMatchObject({
      operation_fields: [{ operation: 'set', field: 'title' }],
      rejected_field: { module: 'artwork', field: 'declared_dimensions' }
    });
  });

  it('never records unknown field names, operation names, codes or correlation strings', () => {
    const failure = new CustomApiCompliantException(
      422,
      privateMarker,
      privateMarker
    );
    loggerContext.run(
      { requestId: `https://${privateMarker}`, jwtSub: privateMarker },
      () => {
        logDocumentationModuleRejection(
          'artwork',
          {
            operations: [
              {
                op: 'set',
                field: privateMarker,
                answer: answer(privateMarker)
              },
              { op: privateMarker, field: 'title' },
              { op: 'set', field: 'title', answer: answer(privateMarker) },
              { op: 'set', field: 'title', answer: answer(privateMarker) },
              { op: 'set', field: 'rights_basis' }
            ],
            filename: privateMarker,
            headers: { authorization: privateMarker }
          },
          failure
        );
      }
    );
    expect(entries).toEqual([
      {
        context: { requestId: undefined },
        message: {
          event: 'documentation_module_validation_rejected',
          operation: 'patch_module',
          module: 'artwork',
          status: 422,
          code: 'VALIDATION_REJECTED',
          operation_fields: [{ operation: 'set', field: 'title' }]
        }
      }
    ]);
    expect(JSON.stringify(entries)).not.toContain(privateMarker);
  });

  it('ignores arbitrary field attribution and leaves error identity and serialization unchanged', () => {
    const failure = new CustomApiCompliantException(
      422,
      privateMarker,
      'INVALID_VALUE'
    );
    const serialized = JSON.stringify(failure);
    const same = rejected(() =>
      withDocumentationValidationField('artwork', privateMarker, () => {
        throw failure;
      })
    );
    expect(same).toBe(failure);
    expect(JSON.stringify(failure)).toBe(serialized);
    expect(documentationValidationField(failure)).toEqual({
      module: 'artwork',
      field: privateMarker
    });
    logDocumentationModuleRejection('artwork', {}, failure);
    expect(entries[0].message).not.toHaveProperty('rejected_field');
    expect(JSON.stringify(entries)).not.toContain(privateMarker);
  });

  it('keeps the innermost field attribution when validators are nested', () => {
    const failure = rejected(() =>
      withDocumentationValidationField('artwork', 'title', () =>
        withDocumentationValidationField(
          'files',
          'preservation_master_status',
          () => fail(422, 'EXPLANATION_REQUIRED')
        )
      )
    );
    expect(documentationValidationField(failure)).toEqual({
      module: 'files',
      field: 'preservation_master_status'
    });
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { operations: 'invalid' },
    { operations: [null, 1, privateMarker] }
  ])(
    'handles malformed request shapes without including their content: %p',
    (body) => {
      logDocumentationModuleRejection(
        'artwork',
        body,
        rejected(() => fail(422, 'INVALID_REQUEST'))
      );
      expect(entries[0].message).toMatchObject({
        code: 'INVALID_REQUEST',
        operation_fields: []
      });
    }
  );

  it('bounds operation processing to the existing request limit', () => {
    logDocumentationModuleRejection(
      'artwork',
      {
        operations: [
          ...Array.from({ length: 100 }, () => ({
            op: 'set',
            field: privateMarker
          })),
          { op: 'set', field: 'title' }
        ]
      },
      rejected(() => fail(422, 'INVALID_REQUEST'))
    );
    expect(entries[0].message).toMatchObject({ operation_fields: [] });
  });

  it('does not log other failures, unknown modules or non-errors', () => {
    for (const status of [400, 401, 403, 404, 409, 500])
      logDocumentationModuleRejection(
        'artwork',
        {},
        new CustomApiCompliantException(status, privateMarker)
      );
    logDocumentationModuleRejection(
      privateMarker,
      {},
      rejected(() => fail(422, 'INVALID_MODULE'))
    );
    logDocumentationModuleRejection('artwork', {}, new Error(privateMarker));
    logDocumentationModuleRejection('artwork', {}, null);
    expect(entries).toEqual([]);
  });

  it('does not let logging failures change the validation outcome', () => {
    warn.mockImplementation(() => {
      throw new Error('Unavailable logging');
    });
    expect(() =>
      logDocumentationModuleRejection(
        'artwork',
        {},
        rejected(() => fail(422, 'INVALID_VALUE'))
      )
    ).not.toThrow();
  });
});
