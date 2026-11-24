const { LifecycleError } = require('../services/accountLifecycle.service.cjs');

function createDeletedAccountsRouter({ express, lifecycle, requireAdmin, requireRecoveryPermission, getVerifiedAdminId }) {
    if (typeof express?.Router !== 'function' || typeof lifecycle?.list !== 'function' || typeof lifecycle?.details !== 'function' || typeof lifecycle?.restore !== 'function' || typeof requireAdmin !== 'function' || typeof requireRecoveryPermission !== 'function' || typeof getVerifiedAdminId !== 'function') {
        throw new TypeError('Express, lifecycle service and verified admin authorization required');
    }
    const router = express.Router();
    const handler = fn => async (req, res) => {
        try {
            const adminId = await getVerifiedAdminId(req);
            if (typeof adminId !== 'string' || !adminId.trim() || adminId.length > 128) throw new LifecycleError(403, 'ADMIN_ID_REQUIRED');
            const data = await fn(req, adminId);
            return res.status(200).json(data);
        } catch (error) {
            const known = error instanceof LifecycleError;
            return res.status(known ? error.status : 503).json({ error: known ? error.code : 'ACCOUNT_LIFECYCLE_UNAVAILABLE' });
        }
    };
    router.use(requireAdmin);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });
    router.get('/', handler(req => lifecycle.list({ search: req.query.search, page: req.query.page, status: req.query.status })));
    router.get('/:recordId', handler(req => lifecycle.details(req.params.recordId)));
    router.post('/:recordId/restore', requireRecoveryPermission, handler((req, adminId) => lifecycle.restore(req.params.recordId, adminId)));
    return router;
}

module.exports = { createDeletedAccountsRouter };
