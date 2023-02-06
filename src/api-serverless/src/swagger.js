const swaggerAutogen = require('swagger-autogen')();

const outputFile = './swagger_output.json';
const endpointsFiles = ['./app.ts'];

swaggerAutogen(outputFile, endpointsFiles);
