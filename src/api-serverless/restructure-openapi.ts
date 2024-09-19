import * as fs from 'fs';
import * as yaml from 'js-yaml';

const filePath = './openapi.yaml';

// Load the YAML file
const fileContents = fs.readFileSync(filePath, 'utf8');
const data = yaml.load(fileContents) as Record<string, any>;

// Function to sort an object at the first level
const sortObjectFirstLevel = (
  obj: Record<string, any>
): Record<string, any> => {
  return Object.keys(obj)
    .sort((a, b) => a.localeCompare(b)) // Use localeCompare for reliable sorting
    .reduce((acc, key) => {
      acc[key] = obj[key]; // Keep the value as is
      return acc;
    }, {} as Record<string, any>);
};

// Function to sort paths by the first tag
const sortPathsByFirstTag = (
  paths: Record<string, any>
): Record<string, any> => {
  const sortedPaths = Object.entries(paths)
    .map(([path, methods]) => {
      // Extract the first tag for each operation
      const firstTag = Object.values(methods)
        .flatMap((method: any) => method.tags || [])
        .at(0); // Get the first tag
      return { path, methods, firstTag };
    })
    .sort((a, b) => {
      return (a.firstTag || '').localeCompare(b.firstTag || '');
    })
    .reduce((acc, { path, methods }) => {
      acc[path] = methods; // Rebuild the object with sorted paths
      return acc;
    }, {} as Record<string, any>);

  return sortedPaths;
};

// Sort paths
if (data.paths) {
  data.paths = sortPathsByFirstTag(data.paths);
}

// Sort components/schemas by their keys (first level)
if (data.components?.schemas) {
  data.components.schemas = sortObjectFirstLevel(data.components.schemas);
}

// Convert to YAML
let yamlString = yaml.dump(data, { indent: 2 });

// Replace single quotes with double quotes
yamlString = yamlString.replace(/'/g, '"');

// Write the sorted and formatted YAML back to the file
fs.writeFileSync(filePath, yamlString, 'utf8');

console.log('OpenAPI YAML file restructured successfully.');
