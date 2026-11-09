/* ---------- 侧栏底部卡片 ---------- */
// 注册在 sidebar.footer.action（左下角、头像上方）。侧栏展开时显示一张紧凑卡片：
// 状态、本机/服务器版本、上次同步、上传/下载；点下面的「同步」打开设置弹层。
// 侧栏收起成图标栏时只保留一个图标按钮，避免撑破 56px 宽度。

function OwnsyncDock(props) {
  const state = useSyncStore();
  const [showChanges, setShowChanges] = useState(false);
  const wide = !props || props.wide !== false;
  useEffect(() => {
    ensureSyncLoaded();
  }, []);

  const statusMs = state.intervals?.statusMs || 5000;
  const checkMs = state.intervals?.checkMs || 10_000;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    // 按设置里的间隔刷新本机状态（只查本机，不联网）
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshStatusOnly();
    }, statusMs);
    // 按设置里的间隔自动检查服务器版本：不动焦点、不打断输入
    const checkTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (syncState.busy) return;
      checkServerNow({ silent: true });
    }, checkMs);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(checkTimer);
    };
  }, [statusMs, checkMs]);

  const busy = Boolean(state.busy);
  const local = state.status?.local?.version || 0;
  const server = state.remote && !state.remote.error ? 'v' + (state.remote.remoteVersion || 0) : '—';
  const lastSync = !state.status
    ? '—'
    : state.status.local?.updatedAt
      ? fmtTime(state.status.local.updatedAt)
      : '从未同步';
  const relation = relationOf(state.status, state.remote);
  const actions = actionsFor(relation);
  const dirtyCount = state.status?.localChanges?.count || 0;
  const dirtyDetails = state.status?.localChanges?.details || [];
  const dirtySample = state.status?.localChanges?.sample || [];
  const lastUpload = state.lastUpload;
  const canExpand = dirtyCount > 0 || Boolean(lastUpload);
  const pillClass =
    'os-pill os-pill-' +
    (relation.level === 'ok' ? 'ok' : relation.level === 'err' ? 'err' : relation.level === 'muted' ? 'muted' : 'warn');

  const pillChildren = [
    e('span', { className: 'os-dot', 'aria-hidden': 'true', key: 'dot' }),
    relation.text,
    canExpand
      ? e('span', { className: 'os-caret', 'aria-hidden': 'true', key: 'caret' }, showChanges ? '▴' : '▾')
      : null,
  ];

  const pill = canExpand
    ? e(
        'button',
        {
          type: 'button',
          className: pillClass + ' os-pill-button',
          title: dirtyCount > 0 ? '查看有改动的文件' : '查看上次上传结果',
          onClick: () => setShowChanges(value => !value),
        },
        ...pillChildren,
      )
    : e('span', { className: pillClass }, ...pillChildren);

  const changeList = !showChanges || !canExpand
    ? null
    : dirtyCount > 0
      ? e(
          'div',
          { className: 'os-dock-changes os-dock-changes-warn' },
          '有改动的文件（' + dirtyCount + '）：',
          dirtyDetails.length
            ? e(
                'ul',
                null,
                ...dirtyDetails.map(item => e('li', { key: item.path, title: item.path }, item.label)),
              )
            : e('div', { className: 'os-dock-paths' }, dirtySample.join('、')),
          dirtyDetails.length && dirtyCount > dirtyDetails.length
            ? e('div', { className: 'os-dock-more' }, '……还有 ' + (dirtyCount - dirtyDetails.length) + ' 个')
            : null,
        )
      : e(
          'div',
          { className: 'os-dock-changes os-dock-changes-ok' },
          lastUpload.changedCount > 0
            ? '已上传 v' + lastUpload.version + '，这次更新了 ' + lastUpload.changedCount + ' 个改动：'
            : '已是最新 v' + lastUpload.version,
          (lastUpload.changedFiles || []).length
            ? e(
                'ul',
                null,
                ...(lastUpload.changedFiles || []).map(item =>
                  e('li', { key: item.path, title: item.path }, item.label),
                ),
              )
            : null,
          (lastUpload.changedFiles || []).length && lastUpload.changedCount > lastUpload.changedFiles.length
            ? e(
                'div',
                { className: 'os-dock-more' },
                '……还有 ' + (lastUpload.changedCount - lastUpload.changedFiles.length) + ' 个',
              )
            : null,
        );

  // 设置齿轮：打开同步设置弹层
  const gearButton = e(
    'button',
    {
      type: 'button',
      className: 'os-foot',
      title: '同步设置',
      'aria-label': '同步设置',
      onClick: event => {
        let rect = null;
        try {
          rect = event?.currentTarget?.getBoundingClientRect?.() || null;
        } catch {
          rect = null;
        }
        ensureSyncLoaded();
        togglePopover(rect);
      },
    },
    e('span', { className: 'os-nav', 'aria-hidden': 'true' }, e(IconGear)),
    wide ? e('span', { className: 'os-foot-label' }, '设置') : null,
  );

  // 同步按钮：功能稍后实现
  const syncButton = e(
    'button',
    {
      type: 'button',
      className: 'os-foot',
      title: '同步（暂未实现）',
      'aria-label': '同步',
      onClick: () => {},
    },
    e('span', { className: 'os-nav', 'aria-hidden': 'true' }, e(IconSync)),
    wide ? e('span', { className: 'os-foot-label' }, '同步') : null,
  );

  // 重启按钮：规格与「同步」一致，功能稍后实现
  const restartButton = e(
    'button',
    {
      type: 'button',
      className: 'os-foot',
      title: '重启 DSH',
      'aria-label': '重启 DSH',
      onClick: () => askRestart(),
    },
    e('span', { className: 'os-nav', 'aria-hidden': 'true' }, e(IconRestart)),
    wide ? e('span', { className: 'os-foot-label' }, '重启') : null,
  );

  if (!wide) return gearButton;

  return e(
    'div',
    { className: 'os-dock' },
    e(
      'div',
      { className: 'os-dock-card' },
      changeList,
      e('div', { className: 'os-dock-row' }, pill),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '本机'),
        e('span', null, 'v' + local),
      ),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '服务器'),
        e('span', null, server),
      ),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '上次同步'),
        e('span', null, lastSync),
      ),
      e(
        'div',
        { className: 'os-dock-actions' },
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-primary',
            disabled: busy || !actions.upload,
            title: !actions.upload && !busy ? actions.reason : '上传',
            onClick: () => runSyncAction('upload'),
          },
          state.busy === 'upload' ? '上传中…' : '上传',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-danger',
            disabled: busy || !actions.download,
            title: !actions.download && !busy ? actions.reason : '下载',
            onClick: () => runSyncAction('download'),
          },
          state.busy === 'download' ? '下载中…' : '下载',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-check',
            title: '检查服务器上有没有更新版本',
            onClick: () => checkServerNow(),
          },
          state.checking ? '检查中…' : '检查更新',
        ),
      ),
      state.notice
        ? e(
            'div',
            {
              className:
                'os-dock-note os-note-' +
                (state.notice.kind === 'err' ? 'err' : state.notice.kind === 'warn' ? 'warn' : 'ok'),
            },
            e('span', null, state.notice.text),
            state.notice.action
              ? e(
                  'button',
                  { type: 'button', className: 'os-link', onClick: runNoticeAction },
                  state.notice.action.label,
                )
              : null,
          )
        : null,
    ),
    e('div', { className: 'os-dock-foot' }, gearButton, syncButton, restartButton),
  );
}
