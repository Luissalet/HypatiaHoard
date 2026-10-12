"""Execute the frontend's route, id mapping and changed-field helpers with Node."""

import subprocess
from pathlib import Path


def test_route_and_changed_fields(tmp_path):
    root = Path(__file__).resolve().parents[1]
    code = r'''
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const source = fs.readFileSync('src/data/hoardSyncCore.ts','utf8') + '\n' +
  fs.readFileSync('src/data/copilotCore.ts','utf8').replace(/^import[^\n]*\n/, '');
const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
assert.deepEqual(core.routeObjects('#/subject/new'), []);
assert.deepEqual(core.routeObjects('#/subject/s/read/t?tab=notes'), [{kind:'subject',id:'s'},{kind:'topic',id:'t'}]);
assert.deepEqual(core.routeObjects('#/results/run'), [{kind:'session',id:'run'}]);
assert.deepEqual(core.changedFields({prompt:'Old',modelAnswer:'Old answer'}, {prompt:'New',modelAnswer:'Old answer'}), {prompt:'New'});
assert.deepEqual(core.changedFields({tags:['a']}, {tags:undefined}), {tags:undefined});
assert.deepEqual(core.changedObjectFields({header:{centre:'Old',course:'Keep'}}, {header:{centre:'New',course:'Keep'}}), {header:{centre:'New'}});
globalThis.localStorage = {getItem: () => JSON.stringify({subject:{local:'canonical'}})};
assert.equal(core.serverRecordId('subject','local'),'canonical');
assert.equal(core.serverRecordId('topic','own'),'own');
console.log('route, new, partial-save and canonical-id checks passed');
'''
    result = subprocess.run(['node', '--input-type=module', '-e', code], cwd=root, text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
