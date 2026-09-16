/* 账号接入/管理易用性补丁：支持粘贴 Cookie Editor JSON；删除账号只需一次确认并永久清理。 */
(function (V4) {
  'use strict';

  const MAX_JSON_BYTES = 256 * 1024;
  let scheduled = false;

  function byteLength(text) {
    try { return new Blob([text]).size; }
    catch (_) { return String(text || '').length; }
  }

  function showLocalMessage(text, bad) {
    const message = document.querySelector('.onboard .ob-message');
    if (!message) return;
    message.textContent = text || '';
    message.style.color = bad ? 'var(--danger,#ef4444)' : '';
  }

  function enhancePasteImport() {
    const fileInput = document.querySelector('#ob-file');
    if (!fileInput || document.querySelector('#ob-json-paste-wrap')) return;

    const wrap = document.createElement('div');
    wrap.id = 'ob-json-paste-wrap';
    wrap.innerHTML = `
      <div style="margin:16px 0 6px;font-size:14px;color:var(--ink-2);">或者直接粘贴 Cookie Editor 导出的 JSON</div>
      <textarea id="ob-json-paste" rows="8" autocomplete="off" spellcheck="false" placeholder="把完整 JSON 粘贴到这里，不要粘贴到聊天里" style="font-family:var(--mono,monospace);font-size:12px;line-height:1.55;"></textarea>
      <div class="ob-actions"><button type="button" data-import-paste>使用粘贴的 JSON 导入</button></div>
      <p class="ob-muted">内容只提交给本机工作台，仍走与文件导入相同的格式、域名、过期时间和账户身份校验。</p>`;
    fileInput.insertAdjacentElement('afterend', wrap);

    const button = wrap.querySelector('[data-import-paste]');
    const textarea = wrap.querySelector('#ob-json-paste');
    button.onclick = () => {
      let json = textarea.value.trim();
      if (!json) return showLocalMessage('请先粘贴 Cookie Editor 导出的 JSON。', true);
      if (byteLength(json) > MAX_JSON_BYTES) return showLocalMessage('JSON 不能超过 256KB。', true);
      try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('Cookie Editor JSON 应为非空数组');
      } catch (error) {
        return showLocalMessage(`JSON 格式无效：${error.message}`, true);
      }

      try {
        const transfer = new DataTransfer();
        transfer.items.add(new File([json], 'cookie-editor-paste.json', { type: 'application/json' }));
        fileInput.files = transfer.files;
      } catch (error) {
        return showLocalMessage('当前浏览器无法把粘贴内容交给导入流程，请使用上面的文件选择方式。', true);
      }
      json = '';
      textarea.value = '';
      const importButton = document.querySelector('[data-import]');
      if (!importButton) return showLocalMessage('导入按钮暂不可用，请刷新页面后重试。', true);
      importButton.click();
    };
  }

  async function deleteAccount(button, id, name) {
    const label = name || id;
    const ok = window.confirm(`确定彻底删除账号“${label}”吗？\n\n确认后会删除该账号的本机登录 Cookie、账户配置、Profile 和接入草稿。此操作不可恢复。`);
    if (!ok) return;

    const row = button.closest('.acct-manager-row');
    const manager = button.closest('.acct-manager');
    const status = manager && manager.querySelector('.acct-manager-status');
    button.disabled = true;
    if (status) status.textContent = `正在删除“${label}”…`;

    try {
      const result = await V4.apiJson('/api/accounts', 'DELETE', {
        id,
        confirm: true,
        permanent: true,
      }, { includeAccount: false, timeout: 30000 });

      if (!result || !result.ok || !Array.isArray(result.accounts)) throw new Error((result && result.error) || '账号删除响应格式错误');
      V4.archivedAccounts = Array.isArray(result.archived_accounts) ? result.archived_accounts : [];
      V4.setAccounts(result.accounts);
      row && row.remove();

      const cleanupWarnings = result.cleanup && Array.isArray(result.cleanup.warnings) ? result.cleanup.warnings : [];
      if (status) status.textContent = cleanupWarnings.length
        ? `账号已删除；有 ${cleanupWarnings.length} 个本机文件清理警告，可查看服务日志。`
        : `账号“${label}”已彻底删除。`;

      if (!result.accounts.length) {
        const backdrop = document.querySelector('.acct-manager-backdrop');
        backdrop && backdrop.remove();
        location.hash = '#/onboarding';
      }
    } catch (error) {
      button.disabled = false;
      if (status) status.textContent = `删除失败：${(error && error.message) || '未知错误'}`;
      else window.alert(`删除失败：${(error && error.message) || '未知错误'}`);
    }
  }

  function enhanceAccountManager() {
    const manager = document.querySelector('.acct-manager');
    if (!manager) return;

    const subtitle = manager.querySelector('header p');
    if (subtitle) subtitle.textContent = '添加或彻底删除账号';
    const note = manager.querySelector('.acct-manager-note');
    if (note) note.textContent = '添加账号可选择 Cookie Editor JSON 文件，也可在接入页直接粘贴 JSON。删除账号只需一次确认，确认后永久清理本机账号资料。';

    manager.querySelectorAll('[data-account-action="remove"], [data-account-action="purge"]').forEach(button => {
      if (button.dataset.simplePermanentDelete === '1') return;
      button.dataset.simplePermanentDelete = '1';
      button.textContent = '删除';
      const id = button.dataset.accountId;
      const name = button.dataset.accountName;
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        deleteAccount(button, id, name);
      };
    });
  }

  function enhance() {
    scheduled = false;
    enhancePasteImport();
    enhanceAccountManager();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  const observer = new MutationObserver(schedule);
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }), { once: true });
  schedule();
})(window.V4);
