import { getLlm, type ImageInput } from "../providers/llm.js";
import { ParseResumeSchema } from "../schemas.js";
import { workerModels } from "../config.js";
import type { ParsedResume, UserInputs } from "../types.js";

const SYSTEM = `你是严谨的简历解析器。目标不是还原排版，而是提取“职业证据”所需的结构化信息。
铁律：
- 只提取材料里真实存在的信息，绝不编造、不脑补、不把技能罗列升级成成果。
- 图片模糊、信息稀少或识别不确定时：调低 ocr_confidence，并把缺失/低置信点写进 missing_or_low_confidence，而不是猜。
- quantified_results 只收录材料里真实出现的量化结果。
全程使用中文。`;

export async function parseResume(
  images: ImageInput[],
  inputs: UserInputs,
): Promise<{ value: ParsedResume; model: string }> {
  const userText = `请解析以下简历材料，提取结构化职业证据字段。

用户补充信息（可能为空，仅作背景参考，不要当成简历内容）：
${JSON.stringify(inputs, null, 2)}

${images.length === 0 ? "（没有图片，仅依据上面的补充信息，且必须把 ocr_confidence 设为很低）" : "请仔细阅读图片中的简历。"}`;

  const { value, model } = await getLlm().complete({
    system: SYSTEM,
    userText,
    images,
    schema: ParseResumeSchema,
    schemaName: "ParseResume",
    model: workerModels.parseResume!,
    effort: "medium",
  });
  return { value: value as ParsedResume, model };
}
