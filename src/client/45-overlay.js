/* ---------- 设置弹层 ---------- */
// 侧栏卡片负责日常状态与上传/下载；这个弹层只放设置、提示和需要确认的操作。
// 不用遮罩、不铺满屏：打开时仍然可以点开别的对话。
let popoverState = { open: false, anchor: null };
const popoverListeners = new Set();

function publishPopover(next) {
  popoverState = next;
  for (const listener of [...popoverListeners]) {
    try {
      listener(next);
    } catch {
      /* 一个订阅者出错不影响其他订阅者 */
    }
  }
}

function togglePopover(anchor) {
  publishPopover(
    popoverState.open
      ? { open: false, anchor: null }
      : { open: true, anchor: anchor || popoverState.anchor || null },
  );
}

function openPopoverAt(anchor) {
  publishPopover({ open: true, anchor: anchor || popoverState.anchor || null });
}

/** 供状态层在"需要确认/出错"时把设置弹层拉出来。 */
function openPopover() {
  if (!popoverState.open) publishPopover({ open: true, anchor: popoverState.anchor || null });
}

function closePopover() {
  publishPopover({ open: false, anchor: null });
}

function usePopoverState() {
  const [state, setState] = useState(popoverState);
  useEffect(() => {
    popoverListeners.add(setState);
    setState(popoverState);
    return () => {
      popoverListeners.delete(setState);
    };
  }, []);
  return state;
}

function OwnsyncPopover() {
  const state = usePopoverState();

  useEffect(() => {
    if (!state.open || typeof document === 'undefined') return undefined;
    const onKey = event => {
      if (event.key === 'Escape') closePopover();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (!state.open) return null;

  const rect = state.anchor;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight || 800;
  const top = rect && Number.isFinite(rect.top) ? rect.top : viewportHeight - 90;
  const left = rect && Number.isFinite(rect.left) ? rect.left : 12;
  const style = {
    left: Math.max(8, left) + 'px',
    bottom: Math.max(8, viewportHeight - top + 8) + 'px',
    width: 'min(280px, calc(100vw - 24px))',
    maxHeight: 'min(72vh, 640px)',
  };

  return e(
    'div',
    { className: 'os-popover', style, role: 'dialog', 'aria-label': '同步设置' },
    e(
      'div',
      { className: 'os-popover-head' },
      e('span', { className: 'os-popover-title' }, '同步设置'),
      e(
        'button',
        { type: 'button', className: 'os-popover-close', onClick: closePopover, 'aria-label': '关闭' },
        '×',
      ),
    ),
    e('div', { className: 'os-popover-body' }, e(OwnsyncPanel)),
  );
}

/* ---------- 写回遮罩 ---------- */
// 自动恢复期间盖住整个界面：阻止点击与输入，直到写完或超时/取消。
function OwnsyncRecovering() {
  const state = useSyncStore();
  const recovering = state.recovering;
  const cardRef = useRef(null);

  useEffect(() => {
    if (!recovering || !recovering.active) return;
    try {
      cardRef.current?.focus?.();
    } catch {
      /* 拿不到焦点也不影响流程 */
    }
  }, [recovering && recovering.active]);

  if (!recovering || !recovering.active) return null;
  return e(
    'div',
    { className: 'os-lock' },
    e(
      'div',
      {
        className: 'os-lock-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '正在写回本机',
        tabIndex: -1,
        ref: cardRef,
      },
      e('div', { className: 'os-lock-title' }, '需要重启 DSH 才能写回'),
      e('p', { className: 'os-lock-text' }, recovering.message || '请稍候。'),
      recovering.phase === 'manual'
        ? e(
            'div',
            { className: 'os-lock-actions' },
            e('button', { type: 'button', className: 'os-btn os-btn-primary', onClick: restartFromRecover }, '重启 DSH'),
            e('button', { type: 'button', className: 'os-btn', onClick: closeRecoverOverlay }, '稍后'),
          )
        : null,
    ),
  );
}
