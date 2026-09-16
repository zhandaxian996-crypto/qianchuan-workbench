/**
  * 历史账户专用说明已从试用包移除。
 *
 * GET /api/creator-brief?account=xx
 *
 * 定位：给文案/编导 agent 的"写脚本前看一眼"包，全部现成数据拼装，零新数据管道：
 *   - top_materials：近7天消耗 top10 素材（带创意标签/净ROI/单数，标杆池）
 *   - portrait：罗盘人群画像（缓存快照：八大人群/性别/年龄 top）
 *   - avoid_list：避雷清单（近7天消耗≥客单价×2 且净ROI<保本×0.5 的素材特征）
 * 标杆解剖（秒级留存/人群深挖）不做——编导按需调 get_material mode=detail。
 */
const fs = require('fs');
const path = require('path');
const { sendJSON } = require('../lib/utils');
const { validateAccount, getAccountParams } = require('../lib/api-helpers');
const { getDB } = require('../lib/db');
const { PORT, CACHE_DIR } = require('../lib/config');

async function localFetch(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(30000) });
    const j = await res.json().catch(() => null);
    // 2026-07-30 opus 复核实锤：{ok:false} 是 truthy 对象，不判 ok 会让取数失败伪装成"正常无数据"
    if (!j || j.ok === false) return null;
    return j;
  } catch { return null; }
}

function dayStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function parseTags(tagsField) {
  if (!tagsField || tagsField === '-' || tagsField === '[]') return [];
  if (typeof tagsField !== 'string') return [];
  const trimmed = tagsField.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(t => String(t).trim()).filter(t => t && t !== '-');
      }
    } catch {}
  }
  return trimmed
    .split(/[、,，;；\n]+/)
    .map(t => t.trim().replace(/^["']|["']$/g, ''))
    .filter(t => t && t !== '-' && t !== '[]');
}

async function handleCreatorBrief(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  let account;
  try {
    account = validateAccount(url.searchParams.get('account'));
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }

  try {
    const accP = getAccountParams(account);
    const be = accP.break_even_roi || 2.1;
    const db = getDB();
    const end = new Date();
    const start7 = dayStr(new Date(end.getTime() - 6 * 86400000));
    const endS = dayStr(end);

    // 近7天素材聚合（净口径 net_gmv_1h 优先，与 MHS netOf 同口径）
    const rows = db.prepare(`
      SELECT material_id, MAX(material_name) AS name, MAX(tags) AS tags, MAX(duration) AS duration,
             SUM(cost) AS cost, SUM(gmv) AS gmv,
             SUM(CASE WHEN net_gmv_1h != 0 THEN net_gmv_1h ELSE net_gmv END) AS net,
             SUM(orders) AS orders
      FROM material_daily
      WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND material_id != '__EMPTY__'
        AND material_id NOT LIKE 'AIGC::%' AND material_id NOT LIKE 'LIVE::%'
      GROUP BY material_id
    `).all(account, start7, endS);

    const withRoi = rows.map(r => ({
      material_id: r.material_id,
      name: r.name || '',
      tags: r.tags || '',
      duration: r.duration || '',
      cost: +r.cost.toFixed(2),
      orders: r.orders,
      net_roi: r.cost > 0 ? +(r.net / r.cost).toFixed(2) : null,
      pay_roi: r.cost > 0 ? +(r.gmv / r.cost).toFixed(2) : null,
    })).filter(r => r.cost > 0);

    // 标杆池：消耗 top10
    const top_materials = withRoi.slice().sort((a, b) => b.cost - a.cost).slice(0, 10);

    // 效益标杆：近7天耗≥100元 且 净ROI≥保本，按净ROI 降序取 Top5
    const profit_materials = withRoi
      .filter(r => r.cost >= 100 && r.net_roi != null && r.net_roi >= be)
      .sort((a, b) => b.net_roi - a.net_roi || b.cost - a.cost)
      .slice(0, 5);

    const profit_note = profit_materials.length === 0
      ? '本期无效益标杆：跑量素材全部低于保本线，新文案重点解决劝服深度而非找新题材'
      : undefined;

    // 标签缺失标注：top_materials 和 profit_materials 合并去重计数 parseTags 为空的条目
    const combinedMaterials = [];
    const seenMids = new Set();
    for (const m of [...top_materials, ...profit_materials]) {
      if (!seenMids.has(m.material_id)) {
        seenMids.add(m.material_id);
        combinedMaterials.push(m);
      }
    }
    const missingCount = combinedMaterials.filter(m => parseTags(m.tags).length === 0).length;
    const tags_missing = `标杆${combinedMaterials.length}条中${missingCount}条无创意标签`;

    // 1. hot_tags：top_materials 里高频创意标签 Top5 统计
    let hot_tags = [];
    try {
      const tagCounts = {};
      for (const m of top_materials) {
        const rawTags = parseTags(m.tags);
        const uniqueTags = new Set(rawTags);
        for (const t of uniqueTags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
      hot_tags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, 5);
    } catch {
      hot_tags = [];
    }

    // 2. hook_summary：top_materials 的前5秒流失率概况——主查 material_insight 表，磁盘文件兜底
    let hook_summary = null;
    let hook_summary_error = undefined;
    try {
      let insightStmt = null;
      try {
        insightStmt = db.prepare(`
          SELECT lose_rate_5s, stat_date
          FROM material_insight
          WHERE account_id = ? AND material_id = ?
          ORDER BY stat_date DESC
          LIMIT 1
        `);
      } catch {
        insightStmt = null;
      }

      const profileDir = path.join(CACHE_DIR, 'material_profile');
      let cacheFiles = [];
      if (fs.existsSync(profileDir)) {
        try {
          cacheFiles = fs.readdirSync(profileDir);
        } catch {
          cacheFiles = [];
        }
      }

      const validItems = [];
      const totalCount = top_materials.length;

      for (const m of top_materials) {
        const mid = String(m.material_id);
        let val = null;
        let sDate = null;

        // 1) 主数据源：material_insight 表
        if (insightStmt) {
          try {
            const row = insightStmt.get(account, mid);
            if (row && row.lose_rate_5s != null && typeof row.lose_rate_5s === 'number' && !isNaN(row.lose_rate_5s)) {
              val = row.lose_rate_5s;
              sDate = row.stat_date || null;
            }
          } catch {}
        }

        // 2) 兜底：磁盘缓存文件
        if (val == null && cacheFiles.length > 0) {
          const prefix1 = `profile_${account}_${mid}_`;
          const prefix2 = `profile_${mid}_`;
          const matched = cacheFiles
            .filter(f => f.startsWith(prefix1) || f.startsWith(prefix2) || f.includes(`_${mid}_`))
            .sort()
            .reverse();

          if (matched.length) {
            try {
              const content = fs.readFileSync(path.join(profileDir, matched[0]), 'utf8');
              const json = JSON.parse(content);
              const prof = json.profile || json;
              const ret = prof && prof.retention;
              const fileVal = ret ? (ret.lose_rate_5s ?? ret.churnRate5s) : (prof ? (prof.lose_rate_5s ?? prof.churnRate5s) : null);
              if (fileVal != null && typeof fileVal === 'number' && !isNaN(fileVal)) {
                val = fileVal;
              }
            } catch {}
          }
        }

        if (val != null) {
          validItems.push({
            material_id: mid,
            name: m.name || '',
            churn_rate_5s: +val.toFixed(2),
            stat_date: sDate,
          });
        }
      }

      const dataCount = validItems.length;
      const coverage = `${totalCount}条中${dataCount}条有留存数据`;
      const statDates = validItems.map(i => i.stat_date).filter(Boolean);
      const asOf = statDates.length > 0 ? statDates.reduce((max, d) => (d > max ? d : max), statDates[0]) : null;

      if (dataCount > 0) {
        const sum = validItems.reduce((acc, cur) => acc + cur.churn_rate_5s, 0);
        const avg = +(sum / dataCount).toFixed(2);
        const sorted = validItems.slice().sort((a, b) => a.churn_rate_5s - b.churn_rate_5s);
        hook_summary = {
          total_count: totalCount,
          data_count: dataCount,
          coverage,
          avg_churn_rate_5s: avg,
          as_of: asOf,
          best: sorted[0],
          worst: sorted[sorted.length - 1],
        };
      } else {
        hook_summary = {
          total_count: totalCount,
          data_count: 0,
          coverage,
          avg_churn_rate_5s: null,
          as_of: null,
          best: null,
          worst: null,
        };
      }
    } catch (e) {
      hook_summary = null;
      hook_summary_error = `hook_summary 解析失败: ${e.message}`;
    }

    // 避雷清单：消耗≥客单价×2 且净ROI<保本×0.5（止损口径同 boostGuard）
    const avgPrice = accP.avg_order_price || 100;
    const avoid_list = withRoi
      .filter(r => r.cost >= avgPrice * 2 && r.net_roi != null && r.net_roi < be * 0.5)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10)
      .map(r => ({ ...r, why: `近7天耗 ${r.cost} 元（过探量线 ${(avgPrice * 2).toFixed(0)}），净ROI ${r.net_roi} < 保本×0.5（${(be * 0.5).toFixed(2)}）——话术/人群/承诺强度别照抄` }));

    // 罗盘人群画像（缓存快照，陈旧/缺失不阻断）
    // 2026-07-30 审计修复：取数失败显式标注 portrait_error（此前"接口挂了"与"无画像缓存"都只有 portrait:null 不可区分）
    const compass = await localFetch(`/api/compass?account=${encodeURIComponent(account)}`);
    let portrait = null;
    let portraitError = compass ? undefined : 'compass 画像取数失败';
    try {
      const prof = compass && compass.snapshot && compass.snapshot.profile;
      if (prof) {
        const top1 = arr => ([...(arr || [])].sort((a, b) => (b.value || 0) - (a.value || 0))[0] || null);
        portrait = {
          consumer: (prof.consumer || []).slice(0, 3).map(x => ({ name: x.name, pct: +((x.value || 0) * 100).toFixed(1) })),
          sex: top1(prof.sex) && { name: top1(prof.sex).name, pct: +(top1(prof.sex).value * 100).toFixed(1) },
          age: top1(prof.age) && { name: top1(prof.age).name, pct: +(top1(prof.age).value * 100).toFixed(1) },
          collected_at: compass.snapshot.collected_at || null,
        };
      }
    } catch { /* 画像缺失不阻断 */ }

    return sendJSON(res, {
      ok: true,
      account,
      range: `${start7} ~ ${endS}`,
      break_even_roi: be,
      top_materials,
      profit_materials,
      profit_note,
      hot_tags,
      hook_summary,
      hook_summary_error: hook_summary ? undefined : hook_summary_error,
      avoid_list,
      portrait,
      portrait_error: portrait ? undefined : portraitError,
      hints: {
        top_usage: '标杆池：抄结构不抄文案——看 tags/duration 特征，深挖单条用 get_material mode=detail（秒级留存/人群）',
        profit_usage: '效益标杆：能赚到钱的优质素材（近7天耗≥100且净ROI≥保本），优先解剖其说服逻辑',
        avoid_usage: '避雷清单：这些素材的共性（题材/话术/承诺强度）是当前亏钱的写法，新脚本避开',
        hot_tags_usage: '高频创意标签：当前跑量标杆素材集中使用的爆款标签 Top5',
        hook_summary_usage: '前5秒 Hook 留存概况：5秒流失率越低前3秒钩子越强',
      },
      tags_missing,
    });
  } catch (e) {
    console.error('[creator-brief] 异常:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleCreatorBrief;
