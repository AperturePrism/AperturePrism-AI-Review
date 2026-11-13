/**
 * 控制台页面目录：页面自己声明位置，导航和路由共享这份声明。
 * 新页面在 pages/ 中导出 consolePages，无需再修改 App。
 * 示例：export const consolePages = [{ path: '/reports', label: '报告',
 *   group: 'analysis', order: 40, icon: GridIcon, render: () => <Reports /> }];
 */
import type { ReactElement } from "react";
import type { SseState } from "../hooks/useSse";

export type PageContext = { route: string; sse: SseState };
export type PageGroup = "home" | "analysis" | "identity" | "data" | "system";
export type ConsolePage = {
  path: string;
  label: string;
  group: PageGroup;
  order: number;
  hidden?: boolean;
  icon: (props: { size?: number }) => ReactElement;
  render: (context: PageContext) => ReactElement;
};
export type NavGroup = { title?: string; items: ConsolePage[] };

const GROUPS: { key: PageGroup; title?: string }[] = [
  { key: "home" },
  { key: "analysis", title: "分析" },
  { key: "identity", title: "接入与身份" },
  { key: "data", title: "数据与运维" },
  { key: "system", title: "系统" },
];

// Vite 只扫描本目录内的页面；业务代码不会根据服务器字符串加载脚本。
const modules = import.meta.glob<{ consolePages?: ConsolePage[] }>(
  "../pages/*.tsx",
  { eager: true },
);
export const PAGES = Object.values(modules)
  .flatMap((module) => module.consolePages ?? [])
  .sort((left, right) => left.order - right.order);

// 重复路径是开发错误，启动时指出来源，避免后登记的页面悄悄覆盖旧页面。
const paths = new Set<string>();
for (const page of PAGES) {
  if (paths.has(page.path)) throw new Error(`控制台页面路径重复：${page.path}`);
  paths.add(page.path);
}

export const NAV: NavGroup[] = GROUPS.map(({ key, title }) => ({
  ...(title ? { title } : {}),
  items: PAGES.filter((page) => page.group === key && !page.hidden),
})).filter((group) => group.items.length > 0);

/** 返回页面所属的业务分组，用于顶部面包屑。 */
export function routeGroupTitle(active: string): string | undefined {
  return NAV.find((group) => group.items.some((page) => page.path === active))
    ?.title;
}

/** 路由与导航取自同一个页面声明，未知路径保持原来的关于页行为。 */
export function renderConsolePage(
  active: string,
  context: PageContext,
): ReactElement {
  const page =
    PAGES.find((item) => item.path === active) ??
    PAGES.find((item) => item.path === "/about");
  if (!page) throw new Error("控制台缺少关于页面");
  return page.render(context);
}
