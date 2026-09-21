const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./awatch-engine.cjs');
test('compiled Go engine serves concurrent GUI requests with TUI counts', async () => {
  try {
    const [modified, added, removed, empty] = await Promise.all([
      engine.analyze({old_lines:['const value = 1;'],new_lines:['const value = 2;']}),
      engine.analyze({old_lines:[],new_lines:['one','two']}),
      engine.analyze({old_lines:['gone'],new_lines:[]}),
      engine.analyze({old_lines:['same'],new_lines:['same']}),
    ]);
    assert.deepEqual(modified.counts,{adds:0,moves:0,mods:1,dels:0});
    assert.ok(modified.lines.includes('+const value = 2;'));
    assert.deepEqual(added.counts,{adds:2,moves:0,mods:0,dels:0});
    assert.deepEqual(removed.counts,{adds:0,moves:0,mods:0,dels:1});
    assert.deepEqual(empty.counts,{adds:0,moves:0,mods:0,dels:0});
    await assert.rejects(engine.analyze({old_lines:'bad',new_lines:[]}),/Invalid/);
    const conflict = await engine.analyze({old_lines:[],new_lines:[],kind:'lock',result:'conflict',conflict_agent:'Codex',conflict_line_start:12,conflict_line_end:42,detail:'Another agent holds a lock on this range'});
    assert.equal(conflict.detail, 'Codex holds a lock on range 12–42');
    const released = await engine.analyze({old_lines:[],new_lines:[],kind:'lock',result:'released',author:'Codex',line_start:12,line_end:42});
    assert.equal(released.detail, 'Lock released: Codex, range 12–42');
  } finally { engine.stop(); }
});
