const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['all', 'recoverable', 'expired_pending_purge', 'restored']);

class LifecycleError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

function recordId(value) {
    const id = String(value ?? '');
    if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
        throw new LifecycleError(400, 'INVALID_RECORD_ID');
    }
    return id;
}

function createAccountLifecycleService(supabase) {
    if (!supabase || typeof supabase.rpc !== 'function') throw new TypeError('Service-role Supabase client required');

    async function rpc(name, args) {
        let result;
        try {
            result = await supabase.rpc(name, args);
        } catch {
            throw new LifecycleError(503, 'ACCOUNT_LIFECYCLE_UNAVAILABLE');
        }
        if (!result || result.error) {
            if (name === 'shadow_deleted_account_restore' && result?.error?.code === 'P0001') {
                throw new LifecycleError(409, 'ACCOUNT_NOT_RECOVERABLE');
            }
            throw new LifecycleError(503, 'ACCOUNT_LIFECYCLE_UNAVAILABLE');
        }
        return result.data;
    }

    return Object.freeze({
        async canAccess(userId) {
            if (typeof userId !== 'string' || !UUID.test(userId)) throw new LifecycleError(401, 'INVALID_ACCOUNT_ID');
            const data = await rpc('shadow_reader_account_access', { p_user_id: userId });
            if (typeof data !== 'boolean') throw new LifecycleError(503, 'ACCOUNT_LIFECYCLE_UNAVAILABLE');
            return data;
        },
        async list({ search = '', page = 1, status = 'all', dateFrom = '', dateTo = '' } = {}) {
            if (typeof search !== 'string' || search.length > 254 || !STATUSES.has(status) || !/^[0-9]+$/.test(String(page)) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || Number(page) > 100000) {
                throw new LifecycleError(400, 'INVALID_LIST_PARAMETERS');
            }
            const validDate = value => value === '' || (typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !value.startsWith('0000-') && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value);
if (!validDate(dateFrom) || !validDate(dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) throw new LifecycleError(400, 'INVALID_DATE_RANGE');
const data = await rpc('shadow_deleted_accounts_list_v2', { p_search: search.trim(), p_page: Number(page), p_status: status, p_date_from: dateFrom || null, p_date_to: dateTo || null });
            if (!data || !Array.isArray(data.items)) throw new LifecycleError(503, 'ACCOUNT_LIFECYCLE_UNAVAILABLE');
            return data;
        },
        async details(id) {
            const data = await rpc('shadow_deleted_account_details', { p_record_id: recordId(id) });
            if (data == null) throw new LifecycleError(404, 'DELETION_RECORD_NOT_FOUND');
            return data;
        },
        async restore(id, adminId) {
            if (typeof adminId !== 'string' || !adminId.trim() || adminId.length > 128) throw new LifecycleError(403, 'ADMIN_ID_REQUIRED');
            const data = await rpc('shadow_deleted_account_restore', { p_record_id: recordId(id), p_admin_id: adminId.trim() });
            if (data == null) throw new LifecycleError(503, 'ACCOUNT_LIFECYCLE_UNAVAILABLE');
            return { restored: true, record_id: recordId(id) };
        }
    });
}

module.exports = { createAccountLifecycleService, LifecycleError };
