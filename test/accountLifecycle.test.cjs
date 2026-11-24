const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountLifecycleService } = require('../src/services/accountLifecycle.service.cjs');
const { createAccountLifecycleGuard } = require('../src/middleware/accountLifecycleGuard.cjs');
const { createDeletedAccountsRouter } = require('../src/routes/deletedAccounts.routes.cjs');
const userId = 'aabbccdd-1234-5678-9abc-aabbccddeeff';

function service(response, calls = []) {
    return createAccountLifecycleService({ rpc: async (name, args) => { calls.push({ name, args }); return response; } });
}

test('guard allows verified active accounts', async () => {
    const guard = createAccountLifecycleGuard({ lifecycle: service({ data: true }), getVerifiedUserId: req => req.user.id });
    await guard.assertAccess(userId);
});

test('guard denies blocked accounts and fails closed on RPC failure', async () => {
    for (const [response, status] of [[{ data: false }, 403], [{ error: { code: 'XX000' } }, 503], [{ data: null }, 503]]) {
        const guard = createAccountLifecycleGuard({ lifecycle: service(response), getVerifiedUserId: req => req.user.id });
        await assert.rejects(guard.assertAccess(userId), { status });
    }
});

test('list sends expected arguments and rejects invalid input', async () => {
    const calls = [];
    const lifecycle = service({ data: { items: [], total: 0 } }, calls);
    await lifecycle.list({ page: '2', status: 'recoverable' });
    assert.deepEqual(calls[0], { name: 'shadow_deleted_accounts_list', args: { p_search: '', p_page: 2, p_status: 'recoverable' } });
    await assert.rejects(lifecycle.list({ page: 0 }), { status: 400 });
});

test('restore uses verified actor and handles expired record', async () => {
    const calls = [];
    const lifecycle = service({ data: 1 }, calls);
    assert.deepEqual(await lifecycle.restore('1', 'admin-1'), { restored: true, record_id: '1' });
    assert.deepEqual(calls[0].args, { p_record_id: '1', p_admin_id: 'admin-1' });
    await assert.rejects(lifecycle.restore('1', ''), { status: 403 });
    await assert.rejects(service({ error: { code: 'P0001' } }).restore('1', 'admin-1'), { status: 409 });
});

test('router exposes only list, details and permission-gated restore', () => {
    const registrations = [];
    const router = {};
    for (const verb of ['use', 'get', 'post']) router[verb] = (...args) => registrations.push([verb, ...args]);
    const requireAdmin = () => {};
    const requireRecoveryPermission = () => {};
    createDeletedAccountsRouter({ express: { Router: () => router }, lifecycle: service({ data: null }), requireAdmin, requireRecoveryPermission, getVerifiedAdminId: () => 'admin-1' });
    assert.equal(registrations[0][1], requireAdmin);
    assert.deepEqual(registrations.filter(x => x[0] !== 'use').map(x => x.slice(0, 2)), [['get', '/'], ['get', '/:recordId'], ['post', '/:recordId/restore']]);
    assert.equal(registrations.find(x => x[0] === 'post')[2], requireRecoveryPermission);
});
