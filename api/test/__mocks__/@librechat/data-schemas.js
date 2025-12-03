const jestMock = require('jest-mock');

module.exports = {
  logger: {
    warn: jestMock.fn(),
    error: jestMock.fn(),
    debug: jestMock.fn(),
    info: jestMock.fn(),
  },
};
