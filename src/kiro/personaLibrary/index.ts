/**
 * Persona_Library：Bridge 随包提供的默认角色内容资产。
 *
 * 首批覆盖两类场景：客服问答类 + 代码审查类。
 * 用于 `/agent install-defaults` 命令安装到 ~/.kiro/agents/。
 *
 * 用静态 import 把 JSON 内容内联进 tsup bundle，避免运行时按路径读文件
 * （tsup 打成单文件 bundle 后，源文件目录结构不保留，运行时读不到 .json）。
 */
import customerService from './customer-service.json';
import codeReviewer from './code-reviewer.json';

export interface PersonaLibraryEntry {
  name: string;
  config: Record<string, unknown>;
}

/**
 * 列出所有默认角色。
 */
export function listPersonaLibrary(): PersonaLibraryEntry[] {
  return [
    { name: 'customer-service', config: customerService as Record<string, unknown> },
    { name: 'code-reviewer', config: codeReviewer as Record<string, unknown> },
  ];
}
