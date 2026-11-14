/** 工作台主体通过同一目录中的 tab 声明提供入口，新增主体无需改页签列表。 */
import type { ReactElement } from "react";
export type WorkbenchTabProps = { repository: string };
export type WorkbenchTab = {
  id: string;
  label: string;
  description: string;
  order: number;
  render: (props: WorkbenchTabProps) => ReactElement;
};
const modules = import.meta.glob<{ tab?: WorkbenchTab }>(
  "../features/workbench/*.tsx",
  { eager: true },
);
export const WORKBENCH_TABS = Object.values(modules)
  .flatMap((module) => (module.tab ? [module.tab] : []))
  .sort((left, right) => left.order - right.order);
