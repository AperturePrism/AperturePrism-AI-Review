/**
 * HTTP 指令目录：启动时读取 commands 中每个文件声明的 routes。
 * 调用：const routes = await loadRoutes(); await dispatch(routes, request, response, id, context)。
 * 文件名只决定发现位置；匹配路径、方法和业务调用都写在所属指令文件里。
 */
import { readdir } from "node:fs/promises"; // 只扫描发布代码，不读取用户上传的内容。
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./http.js";

export type HttpCommand = (
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
) => void | Promise<void>;

/** 一个主体可以声明多个 HTTP 入口；省略 methods 表示主体自己判断方法。 */
export type HttpRoute = {
  path: string | RegExp;
  methods?: readonly string[];
  prefix?: boolean;
  admin?: boolean;
  handle: HttpCommand;
};

export type RouteContext = {
  isAdmin: () => Promise<boolean>;
};

/**
 * 将指令文件和稳定路径直接对应。精确路径先匹配，避免 /tasks/manual 被任务详情吞掉。
 * @param directory 发布后的 commands 目录；测试可以传临时目录。
 * @returns 顺序固定的路由，启动后不会在每个请求里再次扫描。
 */
export async function loadRoutes(
  directory = new URL("../commands/", import.meta.url),
): Promise<readonly HttpRoute[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const routes: HttpRoute[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".js") ||
      entry.name.endsWith(".test.js")
    )
      continue;
    const module = (await import(new URL(entry.name, directory).href)) as {
      routes?: readonly HttpRoute[];
    };
    if (module.routes) routes.push(...module.routes);
  }
  return orderRoutes(routes);
}

/** 按可预测规则排序，不依赖磁盘枚举顺序或模块导入时的副作用。 */
export function orderRoutes(
  routes: readonly HttpRoute[],
): readonly HttpRoute[] {
  const identities = new Set<string>();
  for (const route of routes) {
    if (route.path instanceof RegExp) continue;
    for (const method of route.methods ?? ["*"]) {
      const key = `${route.prefix ? "prefix:" : "exact:"}${route.path}:${method}`;
      if (identities.has(key)) throw new Error(`duplicate HTTP route: ${key}`);
      identities.add(key);
    }
  }
  return [...routes].sort((left, right) => {
    const kind = (route: HttpRoute): number =>
      typeof route.path !== "string" ? 1 : route.prefix ? 2 : 0;
    return (
      kind(left) - kind(right) ||
      String(right.path).length - String(left.path).length
    );
  });
}

/**
 * 只负责路由入口的方法/管理员检查，不接触数据库或业务数据。
 * @returns 找到路径即返回 true，包括已写回 403/405 的情况。
 */
export async function dispatch(
  routes: readonly HttpRoute[],
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  context: RouteContext,
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const matching = routes.filter((route) => {
    if (route.path instanceof RegExp) {
      route.path.lastIndex = 0; // 全局正则也必须在每个请求从头匹配。
      return route.path.test(pathname);
    }
    return (
      route.path === pathname ||
      (route.prefix && pathname.startsWith(`${route.path}/`))
    );
  });
  if (matching.length === 0) return false;
  const exact = matching.filter(
    (route) => typeof route.path === "string" && !route.prefix,
  );
  const expressions = matching.filter((route) => route.path instanceof RegExp);
  const mostSpecific = matching.reduce(
    (length, route) => Math.max(length, String(route.path).length),
    0,
  );
  const matches = exact.length
    ? exact
    : expressions.length
      ? expressions
      : matching.filter((route) => String(route.path).length === mostSpecific);
  const route = matches.find(
    (candidate) =>
      !candidate.methods || candidate.methods.includes(request.method ?? "GET"),
  );
  if (!route) {
    const methods = [
      ...new Set(matches.flatMap((match) => match.methods ?? [])),
    ];
    response.setHeader("allow", methods.join(", "));
    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
    return true;
  }
  if (route.admin && !(await context.isAdmin())) {
    json(
      response,
      403,
      { status: "error", reason: "admin required" },
      requestId,
    );
    return true;
  }
  await route.handle(request, response, requestId);
  return true;
}

export type RouteDescription = {
  path: string;
  methods: readonly string[];
  match: "exact" | "prefix" | "pattern";
  admin: boolean;
};

/** 运行时路由就是文档的数据源，不手写第二份接口清单。 */
export function describeRoutes(
  routes: readonly HttpRoute[],
): readonly RouteDescription[] {
  return routes.map((route) => ({
    path: typeof route.path === "string" ? route.path : route.path.source,
    methods: route.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"],
    match:
      route.path instanceof RegExp
        ? "pattern"
        : route.prefix
          ? "prefix"
          : "exact",
    admin: route.admin === true,
  }));
}

/**
 * 自动形成 OpenAPI 路径和权限说明；没有声明字段格式的旧接口保留通用对象 schema。
 * prefix 和 RegExp 入口保存在扩展字段，避免把非 OpenAPI 路径假装成精确模板。
 */
export function buildOpenApi(
  routes: readonly HttpRoute[],
  publicPaths: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const patterns: RouteDescription[] = [];
  for (const route of describeRoutes(routes)) {
    if (route.match !== "exact") {
      patterns.push(route);
      continue;
    }
    const entry = (paths[route.path] ??= {});
    for (const method of route.methods) {
      entry[method.toLowerCase()] = {
        operationId: `${method.toLowerCase()}_${route.path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        summary: `${method} ${route.path}`,
        "x-admin-required": route.admin,
        security: publicPaths.has(route.path)
          ? []
          : [{ bearerAuth: [] }, { sessionCookie: [] }],
        responses: {
          "200": { description: "业务返回；字段由对应主体指令定义" },
          "400": { description: "输入格式或业务条件不满足" },
          "401": { description: "需要登录或令牌无效" },
          ...(route.admin ? { "403": { description: "需要管理员身份" } } : {}),
          "405": { description: "当前路径不支持该请求方法" },
          "429": { description: "当前来源已用完一分钟请求额度" },
          "500": { description: "内部故障，使用 x-request-id 关联日志" },
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "AperturePrism Review API",
      version: "1.0.0",
      description: "从应用实际加载的路由生成；字段级请求约束以各主体指令为准。",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        sessionCookie: { type: "apiKey", in: "cookie", name: "__ap_session" },
      },
    },
    "x-aperture-pattern-routes": patterns,
  };
}

/** 创建只读发现入口；注册列表显式传入，文档和请求分派不会悄悄读另一份全局状态。 */
export function discoveryRoutes(
  getRoutes: () => readonly HttpRoute[],
  publicPaths: ReadonlySet<string>,
): readonly HttpRoute[] {
  return [
    {
      path: "/api/routes",
      methods: ["GET"],
      handle: (_request, response, id) =>
        json(response, 200, { items: describeRoutes(getRoutes()) }, id),
    },
    {
      path: "/openapi.json",
      methods: ["GET"],
      handle: (_request, response, id) =>
        json(response, 200, buildOpenApi(getRoutes(), publicPaths), id),
    },
  ];
}
