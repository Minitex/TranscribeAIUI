// Compatibility shim, NOT a build artifact -- this file is committed to the
// repo and tsc never touches it (outDir for src/electron/tsconfig.json is
// ../../dist-electron, so the real compiled output never lands here).
//
// main.ts and mistralImage.ts import this module as './markdownRenderWorker.js'
// per the NodeNext module convention: TypeScript source under
// `module: "NodeNext"` must reference the .js extension that the *compiled*
// sibling file will have, even though only markdownRenderWorker.ts exists on
// disk. When Electron actually runs (dev or packaged), that import resolves
// to the real compiled dist-electron/markdownRenderWorker.js and this file
// is irrelevant.
//
// But `node --test src/electron/mistralImage.test.mjs` loads mistralImage.ts
// directly via Node's TypeScript type-stripping, with no build step. Node's
// module resolution is literal in that mode -- it does not fall back from a
// `.js` specifier to a sibling `.ts` file -- so without this shim that direct
// test run would fail with ERR_MODULE_NOT_FOUND. This file exists purely to
// satisfy that literal resolution, forwarding to the real implementation
// (which Node *can* load directly once the specifier itself says `.ts`).
export * from './markdownRenderWorker.ts';
