// ── N8 TUI seats+send 命令族（形三 α · 设计卷 ec79feb7d §三·门①裁 c8544a1e7）──
//
// v2 域内命令族·零改现役 cli.ts（v2 shadow 零接现役红线）。
// - runCommand=纯函数（返回输出串·零 console 副作用=测试纯断言）；请求面错误
//   抛 UserError（调用面 main 捕获落 stderr+exitCode——instanceof 区分照
//   errors.ts 正形）。
// - 命令谱：
//   · seats list——engine.seats.list() 全谱表（name/address/status/host·
//     ORDER BY name 稳定序=仓储面语义注③现形）
//   · seats get <name>——单席四字段行（未知名 UserError=裁量注②错误输出面）
//   · send <name> <text...>——resolve 正名精确等值→命中落 seat-send 效果行
//     （kind='seat-send'·key=name·payload={address,text,at}·at=数据字段注入
//     形裁量注③——与 D-47 落款时戳语义两分勿混）——零拨号：无 transport/
//     handler 注册·行留库候消费（真消费 handler=嫁接域裁⑤不注册；send→ticket
//     转化面候后续需求嫁接窗=裁⑥注释锚）
//   · status——passes health+effects snapshot+seat-send pending 概览（视图面）
// - main=薄壳（Engine.open→runCommand→console.log→stop·finally 停机零泄漏）；
//   直跑守卫=import.meta.url 对表（tsx 直跑入口·stateDir 参数）。

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from './engine.js';
import { UserError } from './errors.js';
import type { SeatRecord } from './seats.js';
import type { PassesHealthEntry } from './passes.js';

const defaultNow = (): string => new Date().toISOString();

const row = (seat: SeatRecord): string =>
  `${seat.name}\t${seat.address}\t${seat.status}\t${seat.host}`;

/** 点名解析入口（正名精确等值·未知名 UserError——错误输出面裁量注②）。 */
function lookup(engine: Engine, name: string): SeatRecord {
  const seat = engine.seats.resolve(name);
  if (seat === undefined) throw new UserError(`unknown seat: ${name}`);
  return seat;
}

function seatsList(engine: Engine): string {
  const seats = engine.seats.list();
  return `seats (${seats.length})\n${seats.map(row).join('\n')}`;
}

/** status 视图：passes health（N7 passesHealth 读面）+effects snapshot+pending 概览。 */
function statusView(engine: Engine): string {
  const lines: string[] = [];
  const passes: PassesHealthEntry | undefined = engine.passesHealth();
  lines.push(passes === undefined
    ? 'passes\tno pass yet'
    : `passes\t${passes.state}\t${passes.detail}\t${passes.at}`);
  for (const [kind, entry] of Object.entries(engine.effects.snapshot())) {
    lines.push(`effect\t${kind}\t${entry.state}\t${entry.detail}\t${entry.at}`);
  }
  lines.push(`pending seat-send\t${engine.effects.pending('seat-send')}`);
  return lines.join('\n');
}

export function runCommand(engine: Engine, argv: readonly string[], now: () => string = defaultNow): string {
  const command: string | undefined = argv[0];
  if (command === 'seats') {
    const sub: string | undefined = argv[1];
    if (sub === 'list') return seatsList(engine);
    if (sub === 'get') {
      const name: string | undefined = argv[2];
      if (name === undefined) throw new UserError('usage: seats get <name>');
      return row(lookup(engine, name));
    }
  } else if (command === 'send') {
    const target: string | undefined = argv[1];
    if (target === undefined) throw new UserError('usage: send <name> <text...>');
    const text = argv.slice(2).join(' ');
    if (text.length === 0) throw new UserError('send: text is required');
    const seat = lookup(engine, target);
    // seat-send 效果行（消息投递语义·SendMessage 等价）——零拨号落行·行留库候消费。
    engine.effects.enqueue('seat-send', seat.name, { address: seat.address, text, at: now() });
    return `queued seat-send → ${seat.name} (${seat.address})`;
  } else if (command === 'status') {
    return statusView(engine);
  }
  throw new UserError(`unknown command: ${command ?? '(none)'}; usage: seats list | seats get <name> | send <name> <text...> | status`);
}

/** 薄壳入口（零改现役 cli.ts——本件独立入口·嫁接位候后续需求）。 */
export async function main(argv: readonly string[], stateDir: string): Promise<number> {
  const engine = Engine.open(stateDir);
  try {
    console.log(runCommand(engine, argv));
    return 0;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await engine.stop();
  }
}

const argv1: string | undefined = process.argv[1];
const invoked = argv1 === undefined ? '' : pathToFileURL(argv1).href;
if (import.meta.url === invoked) {
  const stateDir = process.env.TRIRLC_V2_STATE_DIR ?? join(process.cwd(), '.trirlc-v2');
  void main(process.argv.slice(2), stateDir).then((code) => { process.exitCode = code; });
}
