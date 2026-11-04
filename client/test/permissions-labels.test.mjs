// The permissions a role can grant: the page lists the same ones the server knows, and every one has its words in
// every language (the labels are built from the permission's name, so no other check would find a missing one).
//
//   node --test client/test/permissions-labels.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS } from '../../server/src/roles.js';
import { PERMISSION_GROUPS } from '../src/renderer/roles.js';
import en from '../src/renderer/locales/en.js';
import es from '../src/renderer/locales/es.js';
import ptBR from '../src/renderer/locales/pt-BR.js';

const listed = PERMISSION_GROUPS.flatMap((g) => g.permissions);

test('the page lists exactly what the server can grant', () => {
  assert.deepEqual([...listed].sort(), [...PERMISSIONS].sort());
});

for (const [name, table] of Object.entries({ en, es, 'pt-BR': ptBR })) {
  test(`every permission and group has a label and a hint in ${name}`, () => {
    for (const permission of listed) {
      const key = `server_admin.perm_${permission.replace('.', '_')}`;
      assert.ok(table[key], key);
      assert.ok(table[`${key}_hint`], `${key}_hint`);
    }
    for (const group of PERMISSION_GROUPS) assert.ok(table[`server_admin.group_${group.key}`], group.key);
  });
}
