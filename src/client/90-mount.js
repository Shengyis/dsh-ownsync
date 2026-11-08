/* ---------- 挂载 ---------- */
function apply(ctx) {
  injectStyles();

  // 会话导航：自动恢复时切到空白会话、写完再切回来
  if (typeof ctx.inject === 'function') {
    ctx.inject(['uiWorkspace'], guarded => {
      setWorkspaceNavigation(guarded.uiWorkspace);
      guarded.effect?.(() => () => setWorkspaceNavigation(null));
    });
  }

  // 左下角、头像上方：状态卡片 + 「同步」按钮（点击打开设置弹层）
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-ownsync', order: 40, label: '同步' },
      OwnsyncDock,
    ),
  );

  // 点击按钮后贴着按钮上沿展开的设置弹层（不是整屏弹窗）
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ownsync-popover', order: 900 }, OwnsyncPopover),
  );

  // 自动写回期间的全屏遮罩，阻止输入
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ownsync-recovering', order: 950 }, OwnsyncRecovering),
  );

  // 设置页里也保留一份，找不到侧栏按钮时仍可进入
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'dsh-ownsync-section', order: 420, label: '同步' },
      OwnsyncSection,
    ),
  );
}

module.exports = {
  name: 'dsh-ownsync',
  inject: ['slots'],
  apply,
};
