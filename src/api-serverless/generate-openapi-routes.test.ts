import {
  generateOpenApiRouteFiles,
  OpenApiDocument
} from './generate-openapi-routes';

function getFile(document: OpenApiDocument, relativePath: string): string {
  const file = generateOpenApiRouteFiles(document).find(
    (candidate) => candidate.relativePath === relativePath
  );
  if (!file) {
    throw new Error(`Generated file ${relativePath} not found`);
  }
  return file.content;
}

describe('generateOpenApiRouteFiles', () => {
  it('generates typed route wiring only for opted-in operations', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops': {
          get: {
            operationId: 'getDropsV2',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              handler: {
                import: '@/api/drops/get-drops-v2.handler',
                name: 'handleGetDropsV2'
              }
            },
            parameters: [
              {
                name: 'parent_drop_id',
                in: 'query',
                schema: { type: 'string' }
              },
              {
                name: 'page',
                in: 'query',
                schema: { type: 'integer', format: 'int64' }
              },
              {
                name: 'page_size',
                in: 'query',
                schema: { type: 'integer', format: 'int64' }
              }
            ],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/ApiDropV2PageWithoutCount'
                    }
                  }
                }
              }
            }
          }
        },
        '/v2/drops/{id}': {
          get: {
            operationId: 'getDropV2ById',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ApiDropAndWave' }
                  }
                }
              }
            }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');
    const operations = getFile(document, 'operations.ts');

    expect(routes).toContain("router.get(\n  '/v2/drops'");
    expect(routes).toContain('maybeAuthenticatedUser()');
    expect(routes).toContain(
      "import { handleGetDropsV2 } from '@/api/drops/get-drops-v2.handler';"
    );
    expect(routes).not.toContain('/v2/drops/:id');
    expect(operations).toContain('export interface GetDropsV2Query');
    expect(operations).toContain('"parent_drop_id"?: string;');
    expect(operations).toContain('"page_size"?: number;');
    expect(operations).toContain(
      'export type GetDropsV2Response = ApiDropV2PageWithoutCount;'
    );
    expect(operations).not.toContain('GetDropsV2Handler');
  });

  it('generates required auth and path params', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops/{id}': {
          get: {
            operationId: 'getDropV2ById',
            'x-6529-router': {
              enabled: true,
              auth: 'required',
              handler: {
                import: '@/api/drops/get-drop-v2-by-id.handler',
                name: 'getDropV2ByIdHandler'
              }
            },
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }
            ],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/ApiDropAndWave' }
                  }
                }
              }
            }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');
    const operations = getFile(document, 'operations.ts');

    expect(routes).toContain("router.get(\n  '/v2/drops/:id'");
    expect(routes).toContain('needsAuthenticatedUser()');
    expect(operations).toContain('export interface GetDropV2ByIdPathParams');
    expect(operations).toContain('"id": string;');
  });

  it('registers static routes before parameterized siblings', () => {
    const response = {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiWaveMentionSearchResult' }
        }
      }
    };
    const document: OpenApiDocument = {
      paths: {
        '/v2/waves/{waveId}/mention-search': {
          get: {
            operationId: 'searchWaveMentions',
            'x-6529-router': {
              enabled: true,
              handler: {
                import: '@/api/waves/wave-mention-search.handler',
                name: 'handleSearchWaveMentions'
              }
            },
            responses: { '200': response }
          }
        },
        '/v2/waves/mention-search': {
          get: {
            operationId: 'searchDraftWaveMentions',
            'x-6529-router': {
              enabled: true,
              handler: {
                import: '@/api/waves/wave-mention-search.handler',
                name: 'handleSearchDraftWaveMentions'
              }
            },
            responses: { '200': response }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');

    expect(routes.indexOf("'/v2/waves/mention-search'")).toBeLessThan(
      routes.indexOf("'/v2/waves/:waveId/mention-search'")
    );
  });

  it('generates array response types', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops/{id}/metadata': {
          get: {
            operationId: 'getDropV2MetadataById',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              handler: {
                import: '@/api/drops/get-drop-v2-metadata-by-id.handler',
                name: 'handleGetDropV2MetadataById'
              }
            },
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }
            ],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/ApiDropMetadataV2'
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const operations = getFile(document, 'operations.ts');

    expect(operations).toContain(
      "import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';"
    );
    expect(operations).toContain(
      'export type GetDropV2MetadataByIdResponse = ApiDropMetadataV2[];'
    );
  });

  it('generates request body model types for json body refs', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/waves/{id}/metadata': {
          post: {
            operationId: 'createWaveMetadata',
            'x-6529-router': {
              enabled: true,
              auth: 'required',
              handler: {
                import: '@/api/waves/waves-v2.handlers',
                name: 'handleCreateWaveMetadata'
              }
            },
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ApiCreateWaveMetadataRequest'
                  }
                }
              }
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/ApiWaveMetadata'
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');
    const operations = getFile(document, 'operations.ts');

    expect(routes).toContain("router.post(\n  '/v2/waves/:id/metadata'");
    expect(routes).toContain('needsAuthenticatedUser()');
    expect(operations).toContain(
      "import { ApiCreateWaveMetadataRequest } from '@/api/generated/models/ApiCreateWaveMetadataRequest';"
    );
    expect(operations).toContain(
      'export type CreateWaveMetadataResponse = ApiWaveMetadata;'
    );
    expect(operations).toContain(
      [
        'export type CreateWaveMetadataRequest = Request<',
        '  CreateWaveMetadataPathParams,',
        '  ApiResponse<CreateWaveMetadataResponse>,',
        '  ApiCreateWaveMetadataRequest,'
      ].join('\n')
    );
  });

  it('generates raw csv response route wiring', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops/{id}/votes/download': {
          get: {
            operationId: 'downloadDropV2VotersById',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              handler: {
                import: '@/api/drops/download-drop-v2-voters-by-id.handler',
                name: 'handleDownloadDropV2VotersById'
              }
            },
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }
            ],
            responses: {
              '200': {
                content: {
                  'text/csv': {
                    schema: {
                      type: 'string',
                      format: 'binary'
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');
    const operations = getFile(document, 'operations.ts');

    expect(routes).toContain('res: Response<DownloadDropV2VotersByIdResponse>');
    expect(routes).toContain('await handleDownloadDropV2VotersById(req, res);');
    expect(routes).not.toContain('Response<ApiResponse');
    expect(operations).toContain(
      'export type DownloadDropV2VotersByIdResponse = string;'
    );
    expect(operations).toContain(
      [
        'export type DownloadDropV2VotersByIdRequest = Request<',
        '  DownloadDropV2VotersByIdPathParams,',
        '  DownloadDropV2VotersByIdResponse,'
      ].join('\n')
    );
  });

  it('groups handler imports by module', () => {
    const response = {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiDropAndWave' }
        }
      }
    };
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops': {
          get: {
            operationId: 'getDropsV2',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              handler: {
                import: '@/api/drops/drops-v2.handlers',
                name: 'handleGetDropsV2'
              }
            },
            responses: { '200': response }
          }
        },
        '/v2/drops/{id}': {
          get: {
            operationId: 'getDropV2ById',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              handler: {
                import: '@/api/drops/drops-v2.handlers',
                name: 'handleGetDropV2ById'
              }
            },
            responses: { '200': response }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');

    expect(routes).toContain(
      "import { handleGetDropsV2, handleGetDropV2ById } from '@/api/drops/drops-v2.handlers';"
    );
    expect(routes.match(/@\/api\/drops\/drops-v2\.handlers/g)).toHaveLength(1);
  });

  it('generates optional cache middleware', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops': {
          get: {
            operationId: 'getDropsV2',
            'x-6529-router': {
              enabled: true,
              auth: 'optional',
              cache: {
                ttlSeconds: 900,
                authDependent: true
              },
              handler: {
                import: '@/api/drops/get-drops-v2.handler',
                name: 'handleGetDropsV2'
              }
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/ApiDropV2PageWithoutCount'
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const routes = getFile(document, 'openapi-generated.routes.ts');

    expect(routes).toContain(
      "import { cacheRequest } from '@/api/request-cache';"
    );
    expect(routes).toContain("import { Time } from '@/time';");
    expect(routes).toContain(
      [
        "router.get(\n  '/v2/drops',",
        '  maybeAuthenticatedUser(),',
        '  cacheRequest({ ttl: Time.seconds(900), authDependent: true }),',
        '  async ('
      ].join('\n')
    );
  });

  it('fails when an opted-in operation has no handler metadata', () => {
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops': {
          get: {
            operationId: 'getDropsV2',
            'x-6529-router': { enabled: true },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/ApiDropV2PageWithoutCount'
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    expect(() => generateOpenApiRouteFiles(document)).toThrow(
      'missing handler import/name'
    );
  });

  it('fails when two opted-in operations resolve to the same express route', () => {
    const response = {
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ApiDropAndWave' }
        }
      }
    };
    const document: OpenApiDocument = {
      paths: {
        '/v2/drops/{id}': {
          get: {
            operationId: 'getDropById',
            'x-6529-router': {
              enabled: true,
              handler: {
                import: '@/api/drops/get-drop.handler',
                name: 'getDropHandler'
              }
            },
            responses: { '200': response }
          }
        },
        '/v2/drops/:id': {
          get: {
            operationId: 'getDropByColonId',
            'x-6529-router': {
              enabled: true,
              handler: {
                import: '@/api/drops/get-drop-by-colon-id.handler',
                name: 'getDropByColonIdHandler'
              }
            },
            responses: { '200': response }
          }
        }
      }
    };

    expect(() => generateOpenApiRouteFiles(document)).toThrow(
      'Duplicate generated route GET /v2/drops/:id'
    );
  });
});
