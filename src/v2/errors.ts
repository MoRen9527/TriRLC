// ── N4 票域错误面（形三 α · N4 票域并入）──
//
// 照原型 dsh-superagent assignments/tickets UserError 谱（补读笔记 9f37e4e75）：
// 校验败（questionWithResult/askerWithoutQuestion/assignmentEnded 等）与票域
// closing 守卫共用一个显式可测错误类——调用面（worker Session/嫁接域）按
// instanceof UserError 区分「请求面错误」与内部异常。

/** 票域公开 API 的请求面错误（校验谱/closing 守卫——白盒断言用 message 区分）。 */
export class UserError extends Error {}
