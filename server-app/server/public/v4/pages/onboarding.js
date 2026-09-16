/* 本机接入向导：凭据只从 File 进入本机接口，不入浏览器存储。 */
(function (V4) {
  'use strict';
  const esc = V4.esc;
  const labels = { payment: '支付 ROI', platform_net_1h: '平台 1 小时净成交 ROI', final_settlement: '最终结算 ROI',
    chengfang_comprehensive: '乘方综合 ROI', unknown: '暂不清楚', recommendation_only: '只读建议', confirm_writes: '每次确认后操作（记录意向）',
    auto_guarded: '授权内自主操作（记录意向）', important_only: '重要变化与异常', every_round: '每轮汇报',
    plan_roi: '主计划 ROI', plan_budget: '主计划预算', boost_create: '新建追投', boost_update: '追投调参', boost_pause: '暂停追投',
    boost_resume: '恢复追投', boost_delete: '删除追投', flow_control: '一键控量', volume_start: '一键起量', material_remove: '移出素材' };
  const show = value => value == null ? '暂不清楚' : esc(labels[value] || String(value));
  V4.pages.onboarding = {
    mount(root) {
      let disposed = false, state = null, landing = null, selected = null, busy = false;
      root.innerHTML = `<style>
      .onboard{max-width:880px;margin:20px auto;color:var(--ink);font-size:16px;line-height:1.7}
      .onboard h1{font-size:28px;margin-bottom:8px}.onboard h2{font-size:20px;margin:0 0 12px}
      .onboard .ob-card{border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:24px;margin:20px 0}
      .onboard p{margin:8px 0 16px}.onboard label{display:block;margin:16px 0 6px}
      .onboard input:not([type=checkbox]),.onboard select,.onboard textarea{display:block;width:100%;padding:10px;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;box-sizing:border-box}
      .onboard select option{color:var(--ink);background:var(--bg)}.onboard fieldset{border:1px solid var(--line);border-radius:8px;margin:14px 0}
      .onboard .ob-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.onboard button,.onboard .ob-link{padding:10px 16px;min-height:44px;border-radius:8px;border:1px solid var(--line);font:inherit;background:var(--panel);color:var(--ink);cursor:pointer}
      .onboard button.primary{background:#175cd3;color:white;border-color:#175cd3}.onboard button:disabled{opacity:.55;cursor:wait}
      .onboard .ob-muted{color:var(--ink-2);font-size:14px}.onboard .ob-message{white-space:pre-wrap;overflow-wrap:anywhere}
      .onboard .ob-warning{border-left:3px solid #d98a13;padding:8px 14px}.onboard .ob-steps{margin:0 0 16px;padding:12px 16px;background:var(--bg);border-radius:8px}.onboard .ob-steps strong{display:block}.onboard .ob-steps ol{margin:4px 0 0 20px;padding:0}.onboard dl{display:grid;grid-template-columns:minmax(100px,1fr) 2fr;gap:8px;margin:0}.onboard dd{margin:0;overflow-wrap:anywhere}
      @media(max-width:600px){.onboard{margin:8px}.onboard .ob-card{padding:16px}.onboard dl{display:block}.onboard dd{margin-bottom:12px}}
      </style><section class="onboard"><h1>接入与配置</h1><p>按页面提示完成 4 步：导入账户文件、确认账户、补充配置、只读预演并保存。配置答案会分步保存，不清楚的数值可以留空。</p><div class="ob-message" role="status" aria-live="polite">正在检查已有配置…</div><div class="ob-content"></div></section>`;
      const host = root.querySelector('.ob-content'), message = root.querySelector('.ob-message');
      const api = (body, id) => body
        ? V4.apiJson('/api/onboarding', 'POST', body, { includeAccount: false, headers: { 'x-qc-onboarding': '1' }, timeout: 60000 })
        : V4.api('/api/onboarding', id ? { account_id: id } : {}, { skipAccountParam: true, timeout: 12000 });
      async function run(work) {
        if (busy) return;
        busy = true; host.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = true);
        message.textContent = '正在处理，请稍候。只读验证可能需要几十秒…';
        try { await work(); if (!disposed) message.textContent = ''; }
        catch (e) {
          if (!disposed) {
            message.textContent = e.message || '操作未完成，可重试；已保存的进度仍保留。';
            if (e.code === 'account_selection_required') {
              const extra = host.querySelector('#ob-account-help');
              if (extra) { extra.open = true; host.querySelector('#ob-advertiser')?.focus(); }
            }
          }
        }
        finally { busy = false; if (!disposed) host.querySelectorAll('button,input,select,textarea').forEach(control => control.disabled = false); }
      }
      function field(q) {
        const value = state.answers[q.key];
        if (q.type === 'actions') return `<details><summary>${esc(q.label)}（可选，已选 ${(value || []).length} 项）</summary><fieldset data-actions="${q.key}"><legend>${esc(q.label)}</legend>${q.options.map(key => `<label><input type="checkbox" value="${key}" ${(value || []).includes(key) ? 'checked' : ''}> ${show(key)}</label>`).join('')}</fieldset></details>`;
        if (q.type === 'select') return `<label for="ob-${q.key}">${esc(q.label)}</label><select id="ob-${q.key}" name="${q.key}">${q.options.map(key => `<option value="${key}" ${value === key || (value == null && ['unknown', 'recommendation_only', 'important_only'].includes(key)) ? 'selected' : ''}>${show(key)}</option>`).join('')}</select>`;
        return `<label for="ob-${q.key}">${esc(q.label)}</label><input id="ob-${q.key}" name="${q.key}" type="${q.type === 'number' ? 'number' : 'text'}" ${q.type === 'number' ? 'min="0" step="any"' : 'maxlength="500"'} value="${esc(value ?? '')}">`;
      }
      function renderState() {
        if (disposed) return;
        const current = state.platform_current;
        const questions = state.next_questions;
        host.innerHTML = `<div class="ob-card"><div class="ob-steps"><strong>第 2 步：确认账户与主计划</strong><ol><li>先做一次只读预演，读取账户和计划。</li><li>如有多个计划，只选择你确认过的主计划。</li></ol></div><h2>${esc(state.account.name)}</h2><p class="ob-muted">账户已接入。当前账户原执行模式：${show(state.existing_execution_mode)}。</p><p class="ob-warning">保存本向导后，此账户会切换为只读配置，原自动权限将关闭；不会自动开始投放。</p>
          <div class="ob-actions"><button data-do="read">读取账户与计划 · 只读预演</button><button data-do="credential">更新这个账户的 Cookie</button><button data-do="home">换一个账户</button></div>
          ${state.observations ? `<p class="ob-muted">读取时间：${esc(state.observations.checked_at)} · ${state.observations_fresh ? '十分钟内' : '需重新验证'}</p>
          <label for="ob-plan">主计划（只从本账户真实列表选择）</label><select id="ob-plan"><option value="">暂不选择</option>${state.observations.plans.map(p => `<option value="${esc(p.id)}" ${p.id === state.primary_ad_id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.id)}</option>`).join('')}</select>
          <div class="ob-actions"><button data-do="plan">确认计划选择</button></div>
          <p>平台当前设置：ROI ${show(current?.roi_goal)}（${show(current?.roi_basis || 'unknown')}） · 预算 ${show(current?.budget)} 元 · 余额 ${show(state.observations.balance.available_yuan)} 元</p>
          ${state.observations.plan_conflict ? '<p class="ob-warning">原主计划未在这次列表中核验成功，不会擅自替换。可先保存只读配置。</p>' : ''}` : '<p>先读取当前设置；经营目标与财务保本线会单独询问。</p>'}
          </div>
          ${questions.length ? `<form class="ob-card" id="ob-form"><div class="ob-steps"><strong>第 3 步：补充配置</strong><span>这一组保存后会继续显示下一组；不确定的数值可以留空。</span></div><h2>补齐这一组信息</h2>${questions.map(field).join('')}
          ${questions.some(q => q.key === 'mode') ? '<p class="ob-warning">通过本向导只开通看盘与建议。自动操作选项仅保存你的偏好，暂不会启用。</p>' : ''}
          <div class="ob-actions"><button class="primary" type="submit">保存这一步，继续</button></div></form>` : ''}
          <div class="ob-card"><div class="ob-steps"><strong>第 4 步：核对并保存</strong><span>先完成只读预演，再确认保存。</span></div><h2>配置预览</h2><dl>${state.questions.filter(q => state.answered.includes(q.key)).map(q => `<dt>${esc(q.label)}</dt><dd>${Array.isArray(state.answers[q.key]) ? state.answers[q.key].map(show).join('、') || '无' : show(state.answers[q.key])}</dd>`).join('')}</dl>
          <p class="ob-warning">${esc(state.authorization.explanation)}</p>
          <p>未知 ROI、暂无主计划或无历史数据都可以先只读使用。保存不会调整平台计划。</p>
          <label><input id="ob-confirm" type="checkbox"> 我已核对预览，确认保存为只读配置（原自动权限将关闭）</label>
          <div class="ob-actions"><button class="primary" data-do="save">只读预演并保存</button><button data-do="edit">重新编辑已填信息</button></div></div>`;
        host.querySelector('[data-do=read]').onclick = () => run(async () => { state = await api({ action: 'rehearse', account_id: selected }); renderState(); });
        host.querySelector('[data-do=home]').onclick = () => run(loadLanding);
        host.querySelector('[data-do=credential]').onclick = () => renderImport(true);
        host.querySelector('[data-do=plan]')?.addEventListener('click', () => run(async () => {
          state = await api({ action: 'draft', account_id: selected, revision: state.revision, primary_ad_id: host.querySelector('#ob-plan').value || null }); renderState();
        }));
        host.querySelector('#ob-form')?.addEventListener('submit', event => {
          event.preventDefault(); const answers = {};
          for (const q of questions) answers[q.key] = q.type === 'actions'
            ? [...host.querySelectorAll(`[data-actions=${q.key}] input:checked`)].map(i => i.value)
            : q.type === 'number' ? (host.querySelector(`[name=${q.key}]`).value === '' ? null : Number(host.querySelector(`[name=${q.key}]`).value))
            : host.querySelector(`[name=${q.key}]`).value;
          run(async () => { state = await api({ action: 'draft', account_id: selected, revision: state.revision, answers }); renderState(); });
        });
        host.querySelector('[data-do=edit]').onclick = () => { state.next_questions = state.questions; renderState(); };
        host.querySelector('[data-do=save]').onclick = () => {
          if (!host.querySelector('#ob-confirm').checked) { message.textContent = '请先勾选确认；不会自动替你授权。'; return; }
          run(async () => {
            state = await api({ action: 'rehearse', account_id: selected });
            state = await api({ action: 'save', account_id: selected, revision: state.revision, confirm: true });
            if (!disposed) { renderState(); host.insertAdjacentHTML('afterbegin', '<div class="ob-card"><h2>只读接入已完成</h2><p>可以让 Agent 读取账户配置、获取盘面并给建议。不会自动开始盯盘或投放。</p><a class="ob-link" href="#/overview">回到工作台</a></div>'); }
          });
        };
      }
      async function choose(id) { selected = id; state = await api(null, id); V4.setAcct(id); renderState(); }
      function renderImport(updating = false) {
        if (disposed) return;
        host.innerHTML = `<div class="ob-card"><div class="ob-steps"><strong>第 1 步：导入账户文件</strong><ol><li>点击“打开千川登录”，在千川页面完成登录。</li><li>点击“打开 Cookie Editor”，只导出千川域名的 JSON 文件并保存到本机。</li><li>回到这里选择该 JSON 文件，再确认识别出的账户。</li></ol></div><h2>${updating ? '更新所选账户凭据' : '连接一个新账户'}</h2>
        <p>这里不会替你完成千川登录，也不需要把 Cookie 粘贴到聊天里。文件只用于本机工作台发现账户，请不要选择其他网站导出的文件。</p>
        <div class="ob-actions"><a class="ob-link" href="${esc(landing.login_url)}" target="_blank" rel="noopener noreferrer">打开千川登录</a><a class="ob-link" href="${esc(landing.cookie_editor_url)}" target="_blank" rel="noopener noreferrer">打开 Cookie Editor</a></div>
        <label for="ob-file">选择导出的 JSON 文件</label><input type="file" id="ob-file" accept="application/json,.json">
        <details id="ob-account-help"><summary>提示“多个账户”时，再填写这里</summary><label for="ob-advertiser">你要连接的广告账户 ID</label><input id="ob-advertiser" type="text" inputmode="numeric" autocomplete="off" maxlength="30"><p class="ob-muted">通常可以自动识别。如果提示存在多个账户，请填写你要接入的广告账户 ID；系统仍会核验它是否属于本次登录。</p></details>
        <div class="ob-actions"><button class="primary" data-import>导入并发现账户</button><button data-back>返回</button></div><div class="ob-candidates"></div></div>`;
        host.querySelector('[data-back]').onclick = () => run(loadLanding);
        host.querySelector('[data-import]').onclick = () => run(async () => {
          const input = host.querySelector('#ob-file'), file = input.files[0];
          if (!file || file.size > 256 * 1024) throw new Error('请选择不超过 256KB 的 JSON 文件');
          const advertiserId = host.querySelector('#ob-advertiser').value.trim();
          if (advertiserId && !/^\d{5,30}$/.test(advertiserId)) throw new Error('广告账户 ID 应为 5～30 位数字，请核对后重试');
          let json = await file.text();
          let discovery;
          try { discovery = await api({ action: 'import', cookie_json: json, ...(advertiserId ? { advertiser_id: advertiserId } : {}) }); input.value = ''; } finally { json = ''; }
          if (disposed) return;
          const box = host.querySelector('.ob-candidates');
          box.innerHTML = '<p class="ob-warning">第 2 步：请确认识别出的账户属于你，再继续。</p>' + discovery.candidates.map(c => `<button data-id="${esc(c.candidate_id)}">${esc(c.name)} · ${esc(c.aavid)}</button>`).join('');
          box.querySelectorAll('button').forEach(button => button.onclick = () => run(async () => {
            const result = await api({ action: 'select', discovery_id: discovery.discovery_id, candidate_id: button.dataset.id, ...(updating ? { account_id: selected } : {}) });
            const accounts = await V4.api('/api/accounts', {}, { skipAccountParam: true });
            V4.setAccounts(accounts.accounts);
            await choose(result.account.id);
          }));
        });
      }
      async function loadLanding() {
        landing = await api(); if (disposed) return;
        selected = null;
        host.innerHTML = `<div class="ob-card"><div class="ob-steps">${landing.first_use ? '<strong>你现在只需要能登录自己的千川账户</strong><p>点击下方按钮，跟着提示连接账户。目标和预算稍后再问，不清楚的可以先跳过。</p>' : '<strong>你的接入进度已保存</strong><p>选中已有账户后点击“继续配置”，无需重新登录或导入文件。</p>'}</div><h2>${landing.first_use ? '欢迎，先连接千川账户' : '继续配置已有账户'}</h2>
        ${landing.accounts.length ? `<label for="ob-account">已有账户</label><select id="ob-account">${landing.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><div class="ob-actions"><button class="primary" data-continue>继续配置</button></div>` : ''}
        <div class="ob-actions"><button data-new>${landing.first_use ? '开始连接千川账户' : '连接另一个账户'}</button></div><p class="ob-muted">登录文件只在本机导入，不需要发给 Agent。遇到问题时按页面提示继续，已保存的进度会保留。</p></div>`;
        host.querySelector('[data-new]').onclick = () => renderImport();
        host.querySelector('[data-continue]')?.addEventListener('click', () => run(() => choose(host.querySelector('#ob-account').value)));
      }
      run(loadLanding);
      return () => { disposed = true; root.innerHTML = ''; };
    },
  };
})(window.V4);
