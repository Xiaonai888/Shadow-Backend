const { LifecycleError } = require('../services/accountLifecycle.service.cjs');

function createAccountLifecycleGuard({ lifecycle, getVerifiedUserId }) {
    if (typeof lifecycle?.canAccess !== 'function' || typeof getVerifiedUserId !== 'function') throw new TypeError('Lifecycle service and verified identity resolver required');

    async function assertAccess(userId) {
        if (!await lifecycle.canAccess(userId)) throw new LifecycleError(403, 'ACCOUNT_ACCESS_DISABLED');
    }

    async function middleware(req, res, next) {
        try {
            const userId = await getVerifiedUserId(req);
            if (!userId) throw new LifecycleError(401, 'AUTHENTICATION_REQUIRED');
            await assertAccess(userId);
        } catch (error) {
            const known = error instanceof LifecycleError;
            return res.status(known ? error.status : 503).json({ error: known ? error.code : 'ACCOUNT_LIFECYCLE_UNAVAILABLE' });
        }
        return next();
    }

    return Object.freeze({ assertAccess, middleware });
}

module.exports = { createAccountLifecycleGuard };
