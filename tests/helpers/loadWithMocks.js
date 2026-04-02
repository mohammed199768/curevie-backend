const Module = require('module');

function loadWithMocks(entryPath, mocks = {}) {
  const resolvedEntry = require.resolve(entryPath);
  delete require.cache[resolvedEntry];

  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    try {
      const resolvedRequest = Module._resolveFilename(request, parent, isMain);
      if (Object.prototype.hasOwnProperty.call(mocks, resolvedRequest)) {
        return mocks[resolvedRequest];
      }
    } catch (_) {
      // Fall back to the original loader when resolution fails.
    }

    return originalLoad.apply(this, arguments);
  };

  try {
    return require(resolvedEntry);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolvedEntry];
  }
}

module.exports = {
  loadWithMocks,
};
