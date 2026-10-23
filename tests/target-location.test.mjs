import assert from 'node:assert/strict';
import { compactTargetLocation, targetLocationMarkup } from '../ui/workspace-explorer.js';

assert.deepEqual(compactTargetLocation('src/features/checkout/components/Form.tsx'), { full: 'src/features/checkout/components/Form.tsx', short: '…/components/Form.tsx' });
assert.equal(compactTargetLocation('C:\\repo\\src\\checkout\\Form.tsx').short, '…/checkout/Form.tsx');
assert.equal(compactTargetLocation('src/app.js').short, 'src/app.js');
assert.equal(compactTargetLocation('{{baseUrl}}/api/v1/orders/checkout', true).short, '…/orders/checkout');
assert.deepEqual(compactTargetLocation('https://user:secret@example.com/api/orders?token=secret#private', true), { full: 'https://example.com/api/orders', short: '/api/orders' });
assert.equal(compactTargetLocation('/', true).short, '/');
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
assert.match(targetLocationMarkup('src/deep/folder/file.ts', escape), /Full path/);
assert.match(targetLocationMarkup('src/deep/folder/file.ts', escape), /src\/deep\/folder\/file.ts/);
assert.ok(!targetLocationMarkup('https://user:secret@example.com/a/b/c?token=secret', escape, true).includes('secret'));
console.log('Target location presentation tests passed');
