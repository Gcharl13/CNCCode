'use strict';

/*
 * Smoke-test the vendored geometry engine that lives inside public/index.html.
 *
 * The first two <script> blocks are ClipperLib + the CNC engine (which ends
 * with `module.exports = {...}`). We extract and run them in a vm context so
 * the engine can be exercised headlessly under Node — no browser/DOM needed.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, 'expected at least two <script> blocks (ClipperLib + engine)');
  const sandbox = { module: { exports: {} }, window: {}, console };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  // ClipperLib block declares `var ClipperLib`; running both blocks in the same
  // context makes it a context global the engine block can reference.
  vm.runInContext(blocks[0] + '\n;\n' + blocks[1], sandbox, { filename: 'engine.js' });
  return sandbox.module.exports;
}

const engine = loadEngine();

// A 10x10 square as a classic POLYLINE (same format writeDxf emits).
const SQUARE_DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'POLYLINE', '8', '0', '66', '1', '70', '1',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '10', '20', '0',
  '0', 'VERTEX', '8', '0', '10', '10', '20', '10',
  '0', 'VERTEX', '8', '0', '10', '0', '20', '10',
  '0', 'SEQEND', '8', '0',
  '0', 'ENDSEC', '0', 'EOF'
].join('\r\n') + '\r\n';

test('engine module exports the expected functions', () => {
  for (const fn of ['parseDxf', 'chainLoops', 'bboxOf', 'shoelace']) {
    assert.equal(typeof engine[fn], 'function', `engine.${fn} should be a function`);
  }
});

test('parseDxf + chainLoops produce one closed outer loop with correct bbox', () => {
  const parsed = engine.parseDxf(SQUARE_DXF, 0.01);
  assert.ok(parsed.polylines.length >= 1, 'should parse at least one polyline');

  const loops = engine.chainLoops(parsed.polylines, 0.02);
  assert.equal(loops.loops.length, 1, 'a single square should chain to one loop');

  const outer = loops.loops[0];
  assert.equal(outer.isHole, false, 'the square is an outer loop, not a hole');

  const bb = engine.bboxOf([outer.pts]);
  assert.ok(Math.abs((bb.maxx - bb.minx) - 10) < 1e-6, 'width should be 10');
  assert.ok(Math.abs((bb.maxy - bb.miny) - 10) < 1e-6, 'height should be 10');

  assert.ok(Math.abs(Math.abs(engine.shoelace(outer.pts)) - 100) < 1e-6, 'area should be 100');
});
