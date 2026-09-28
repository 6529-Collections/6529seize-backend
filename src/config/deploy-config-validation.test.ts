import { validateDeployServiceConfig } from './deploy-config.validation';
import config from './deploy-services.json';

const mediaResizer = config.services.find(
  (service) => service.name === 'mediaResizerLoop'
)!;

it('accepts the configured GIF worker CPU allocation', () => {
  expect(mediaResizer.memory_size).toBe(2048);
  expect(() =>
    validateDeployServiceConfig(mediaResizer, new Set())
  ).not.toThrow();
});

it.each([undefined, null, '2048', 0, 1028, 512.5, 10752])(
  'rejects invalid GIF worker memory %s before generating a shell command',
  (memory_size) => {
    expect(() =>
      validateDeployServiceConfig({ ...mediaResizer, memory_size }, new Set())
    ).toThrow('mediaResizerLoop memory_size');
  }
);

it('rejects memory settings that would be silently ignored on another service', () => {
  expect(() =>
    validateDeployServiceConfig(
      { ...mediaResizer, name: 'otherLoop' },
      new Set()
    )
  ).toThrow('memory_size is supported only for mediaResizerLoop');
});
