/* ---------- 设置面板（弹层与设置页共用） ---------- */
function OwnsyncPanel(props) {
  const state = useSyncStore();
  const [draft, setDraft] = useState({ remote: '', branch: 'main' });
  const draftTouched = useRef(false);
  const busy = Boolean(state.busy);
  const relation = relationOf(state.status, state.remote);
  const showStatus = Boolean(props && props.showStatus);

  useEffect(() => {
    if (draftTouched.current || !state.status) return;
    setDraft({ remote: state.status.remote || '', branch: state.status.branch || 'main' });
  }, [state.status]);

  const save = () => saveSyncConfig(draft.remote.trim(), (draft.branch || 'main').trim());

  return e(
    'div',
    { className: 'os-wrap' },
    showStatus
      ? e(
          'span',
          {
            className:
              'os-pill os-pill-' +
              (relation.level === 'ok'
                ? 'ok'
                : relation.level === 'err'
                  ? 'err'
                  : relation.level === 'muted'
                    ? 'muted'
                    : 'warn'),
          },
          e('span', { className: 'os-dot', 'aria-hidden': 'true' }),
          relation.text,
        )
      : null,
    state.confirm
      ? e(
          'section',
          { className: 'os-confirm' },
          e('div', { className: 'os-confirm-text' }, state.confirm.message),
          state.confirm.items.length
            ? e(
                'ul',
                { className: 'os-list' },
                state.confirm.items.slice(0, 50).map(item => e('li', { key: item }, item)),
                state.confirm.items.length > 50
                  ? e('li', { key: 'more' }, '……共 ' + state.confirm.items.length + ' 个')
                  : null,
              )
            : null,
          e(
            'div',
            { className: 'os-confirm-actions' },
            e(
              'button',
              {
                type: 'button',
                className: 'os-btn os-btn-danger',
                onClick: () => runSyncAction(state.confirm.kind, state.confirm.token),
              },
              state.confirm.kind === 'upload' ? '确认上传' : '确认下载',
            ),
            e('button', { type: 'button', className: 'os-btn', onClick: dismissSyncConfirm }, '取消'),
          ),
        )
      : null,
    e(
      'div',
      { className: 'os-settings-body' },
      e(
        'label',
        { className: 'os-field' },
        e('span', { className: 'os-field-label' }, '仓库地址'),
        e('input', {
          className: 'os-input os-input-url',
          type: 'text',
          placeholder: 'ssh://git@server:2222/srv/git/dsh-sync.git',
          value: draft.remote,
          spellCheck: false,
          onChange: event => {
            draftTouched.current = true;
            setDraft(current => ({ ...current, remote: event.target.value }));
          },
        }),
      ),
      e(
        'div',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '分支'),
        e('input', {
          className: 'os-input os-input-branch',
          type: 'text',
          placeholder: 'main',
          value: draft.branch,
          spellCheck: false,
          onChange: event => {
            draftTouched.current = true;
            setDraft(current => ({ ...current, branch: event.target.value }));
          },
        }),
        e(
          'button',
          { type: 'button', className: 'os-btn', disabled: busy, onClick: save },
          state.busy === 'config' ? '保存中…' : '保存',
        ),
      ),
      e(
        'label',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '自动上传'),
        e('input', {
          type: 'checkbox',
          checked: state.status?.autoUpload !== false,
          title: '一轮对话结束、内容稳定后自动上传',
          onChange: event => setAutoUpload(event.target.checked),
        }),
      ),
      e(
        'label',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '本机状态刷新间隔'),
        e('input', {
          className: 'os-input os-input-num',
          type: 'number',
          min: 1,
          max: 600,
          step: 1,
          value: Math.round((state.intervals?.statusMs || 5000) / 1000),
          onChange: event => saveIntervals({ statusMs: Number(event.target.value) * 1000 }),
        }),
        e('span', { className: 'os-field-unit' }, '秒'),
      ),
      e(
        'label',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '服务器自动检查间隔'),
        e('input', {
          className: 'os-input os-input-num',
          type: 'number',
          min: 1,
          max: 600,
          step: 1,
          value: Math.round((state.intervals?.checkMs || 10_000) / 1000),
          onChange: event => saveIntervals({ checkMs: Number(event.target.value) * 1000 }),
        }),
        e('span', { className: 'os-field-unit' }, '秒'),
      ),
    ),
  );
}

/** 设置页里的同一份面板（多显示一行状态，设置页没有侧栏卡片）。 */
function OwnsyncSection() {
  return e('div', { className: 'os-section' }, e(OwnsyncPanel, { showStatus: true }));
}
