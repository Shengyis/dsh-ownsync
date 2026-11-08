// 把 src/client/*.js 按文件名顺序拼成 lib/client.js。
//
// 00-loader-head.js 与 99-loader-tail.js 是模块加载器外壳，必须分别是第一个和
// 最后一个文件；其余文件是工厂函数体内的语句，原样拼接（不做缩进，避免改动
// 模板字符串里的内容）。
//
// 没有打包器、没有依赖，产物可读、可 diff。--check 只比较不写入，
// 用于 npm test 防止"改了源码忘了重新生成"。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src', 'client');
const target = path.join(root, 'lib', 'client.js');
const banner =
  '// 由 scripts/build-client.mjs 从 src/client/ 生成；请修改 src/client/ 后运行 npm run build:client。\n';
const normalize = text => text.replace(/\r\n/g, '\n');

function build() {
  const parts = fs
    .readdirSync(source)
    .filter(name => name.endsWith('.js'))
    .sort();

  for (const name of ['00-loader-head.js', '99-loader-tail.js'])
    if (!parts.includes(name)) throw new Error('src/client/ 缺少 ' + name);
  if (parts[0] !== '00-loader-head.js' || parts.at(-1) !== '99-loader-tail.js')
    throw new Error('模块外壳必须是第一个和最后一个文件');

  return {
    count: parts.length,
    output:
      banner +
      parts
        .map(name => {
          const text = normalize(fs.readFileSync(path.join(source, name), 'utf8'));
          return text.endsWith('\n') ? text : text + '\n';
        })
        .join(''),
  };
}

const { count, output } = build();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? normalize(fs.readFileSync(target, 'utf8')) : null;
  if (current !== output) {
    console.error('lib/client.js 与 src/client/ 不一致：请运行 npm run build:client 后重新提交。');
    process.exit(1);
  }
  console.log('lib/client.js 与 src/client/ 一致（' + count + ' 个源文件）');
} else {
  fs.writeFileSync(target, output);
  console.log('已由 ' + count + ' 个源文件生成 lib/client.js');
}
