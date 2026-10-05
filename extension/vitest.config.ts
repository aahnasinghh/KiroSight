const { resolve } = require('node:path');

const config = {
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
};

export = config;
