/**
 * 定义界面客户端与根元素的 React Context 及读取 Hook。
 * 为React子树注入永久绑定的入口客户端及根DOM引用，防止原生和终端共用错误请求或portal目标；缺少客户端时明确抛错。
 * EN: Defines surface-client/root contexts and their read hooks. Injects a permanently surface-bound client and root DOM ref into React subtrees, preventing native/terminal request or portal-target mixing; a missing client throws explicitly.
 */
import { createContext, useContext, type RefObject } from 'react';
import { defaultSurfaceClient } from './api';

/**
 * 未注入入口上下文时使用默认客户端；根节点上下文用于将浮层限制在当前入口。
 * EN: Use default client without injection; root context confines popup layers to current surface.
 */
export const SurfaceClientContext = createContext(defaultSurfaceClient);
export const SurfaceRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null);
/**
 * 获取当前工作台永久绑定的客户端，异步回调应捕获此客户端而非再次读取全局入口。
 * EN: Get the permanently surface-bound client; async callbacks capture it instead of rereading global surface.
 */
export const useSurfaceClient = () => useContext(SurfaceClientContext);
/**
 * 获取当前入口 DOM 根；portal、焦点和弹窗查询优先限定到该范围。
 * EN: Get surface DOM root; scope portals/focus/dialog queries to it first.
 */
export const useSurfaceRoot = () => useContext(SurfaceRootContext);
