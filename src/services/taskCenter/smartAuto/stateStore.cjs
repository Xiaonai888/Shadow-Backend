const TABLE = 'task_center_smart_auto_state';
const SAVE_RPC = 'task_center_smart_auto_save_v1';

function createStateStore({ supabase, loadContext, maxAttempts = 4 }) {
  if (!supabase || typeof supabase.from !== 'function' || typeof supabase.rpc !== 'function' || typeof loadContext !== 'function' || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new TypeError('Invalid Smart Auto state dependencies');
  return async function withReaderTransaction(readerId, work) {
    if (typeof readerId !== 'string' || !readerId.trim() || readerId.length > 128 || typeof work !== 'function') throw new TypeError('Invalid Smart Auto state request');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { data: row, error } = await supabase.from(TABLE).select('revision,day_start_ms,missions,daily_assigned_ids').eq('reader_id', readerId).maybeSingle();
      if (error) throw new Error('Smart Auto state read failed', { cause: error });
      const revision = row?.revision ?? 0;
      let loaded = false;
      let pending;
      let loadedWindow;
      const result = await work({
        load: async ({ now, window }) => {
          if (loaded) throw new Error('Smart Auto state already loaded');
          loaded = true;
          loadedWindow = window;
          const previous = row?.missions ?? [];
          const dailyAssignedIds = Number(row?.day_start_ms) === window.dayStart ? row.daily_assigned_ids : [];
          const context = await loadContext({ readerId, now, window, previous: structuredClone(previous), dailyAssignedIds: structuredClone(dailyAssignedIds) });
          if (!context || typeof context !== 'object') throw new TypeError('Invalid Smart Auto context');
          return { ...context, previous: context.previous ?? previous, dailyAssignedIds };
        },
        save: async data => {
          if (!loaded || pending || data.window.dayStart !== loadedWindow.dayStart) throw new Error('Invalid Smart Auto state save');
          pending = structuredClone(data);
        }
      });
      if (!loaded) throw new Error('Smart Auto state not loaded');
      if (!pending) return result;
      const { data: saved, error: saveError } = await supabase.rpc(SAVE_RPC, {
        p_reader_id: readerId,
        p_expected_revision: revision,
        p_day_start_ms: pending.window.dayStart,
        p_missions: pending.missions,
        p_daily_assigned_ids: pending.dailyAssignedIds
      });
      if (saveError) throw new Error('Smart Auto state save failed', { cause: saveError });
      if (saved === true) return result;
      if (saved !== false) throw new Error('Invalid Smart Auto save response');
    }
    const error = new Error('Smart Auto selection changed concurrently');
    error.code = 'SMART_AUTO_CONFLICT';
    throw error;
  };
}

module.exports = { createStateStore };
