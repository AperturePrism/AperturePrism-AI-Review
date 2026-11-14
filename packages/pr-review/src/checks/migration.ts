/** 数据变更检查：提醒新增破坏性 SQL 或不可逆字段约束，默认由人确认执行条件。 */
import type { ReviewCheck, CheckObservationInput } from "../checks.js";

const check: ReviewCheck = {
  description: "核对迁移中删除/清空数据、非空约束和批量无条件更新",
  matches: (path) =>
    /\.sql$/iu.test(path) || /(^|\/)(?:migrations?|schema)(\/|$)/u.test(path),
  run(file) {
    const result: CheckObservationInput[] = [];
    let blockComment = false;
    for (const line of file.lines) {
      let statement = line.text;
      // SQL 注释只影响本检查的可见片段，不跨缺失的 diff 区域推断状态。
      if (blockComment) {
        const end = statement.indexOf("*/");
        if (end < 0) continue;
        statement = statement.slice(end + 2);
        blockComment = false;
      }
      statement = statement.replace(/\/\*.*?\*\//gu, "");
      const blockStart = statement.indexOf("/*");
      if (blockStart >= 0) {
        blockComment = true;
        statement = statement.slice(0, blockStart);
      }
      statement = statement.replace(/--.*$/u, "").trim();
      if (!line.changed || !statement) continue;
      if (
        /^(?:DROP\s+(?:TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE\s)/iu.test(
          statement,
        ) ||
        /^ALTER\s+TABLE\b.*\bDROP\s+(?:COLUMN\s+)?/iu.test(statement)
      ) {
        result.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "migration",
          nature: "configuration_fact",
          title: "迁移包含可能删除已有数据的语句",
          message:
            "新增可见 SQL 执行 DROP/TRUNCATE。是否正确取决于迁移目的、历史数据和回滚条件，默认需要人工确认。",
          evidence: line.text,
          recommendation:
            "检查生产备份、灰度顺序、读写兼容性和恢复演练；明确不可逆操作的执行窗口。",
        });
      }
      if (
        /^ALTER\s+TABLE\b.*\b(?:SET\s+NOT\s+NULL|ADD\b.*\bNOT\s+NULL)/iu.test(
          statement,
        ) &&
        !/\bDEFAULT\b/iu.test(statement)
      ) {
        result.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "migration",
          nature: "review_reminder",
          title: "迁移新增未展示默认值的非空约束",
          message:
            "可见单行语句改变 NOT NULL；需要核对已有行是否回填，以及线上锁表/扫描成本。",
          evidence: line.text,
          recommendation:
            "确认回填与约束分阶段执行，检查已有 NULL 值和数据库具体版本的锁行为。",
        });
      }
      if (
        /^(?:DELETE\s+FROM|UPDATE)\s/iu.test(statement) &&
        statement.includes(";") &&
        !/\bWHERE\b/iu.test(statement)
      ) {
        result.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "migration",
          nature: "heuristic",
          title: "单行批量写入语句没有可见 WHERE",
          message:
            "该可见单行语句会影响整个目标范围；可能是有意的数据回填，需核对预期行数。",
          evidence: line.text,
          recommendation:
            "确认全量更新/删除是有意操作，评估事务大小、锁时间和可恢复性。",
        });
      }
    }
    return result;
  },
};
export default check;
