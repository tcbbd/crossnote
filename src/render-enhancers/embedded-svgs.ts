import { readFile } from 'fs';
import { extname } from 'path';
import { MarkdownEngineConfig } from '../markdown-engine-config.js';
import { removeFileProtocol } from '../utility.js';

/**
 * Load local svg files and embed them into html directly.
 * @param $
 */
export default async function enhance(
  $: CheerioStatic,
  options: MarkdownEngineConfig,
  resolveFilePath: (path: string, useRelativeFilePath: boolean) => string,
): Promise<void> {
  const asyncFunctions: Promise<string | null>[] = [];
  $('img').each((i, img) => {
    const $img = $(img);
    let src = resolveFilePath($img.attr('src'), false);

    const fileProtocolMatch = src.match(/^(file|vscode-resource):\/\/+/);
    if (fileProtocolMatch) {
      src = removeFileProtocol(src);
      src = src.replace(/\?(\.|\d)+$/, ''); // remove cache
      const imageType = extname(src).slice(1);
      if (imageType !== 'svg') {
        return;
      }
      asyncFunctions.push(
        new Promise(resolve => {
          readFile(decodeURI(src), (error, data) => {
            if (error) {
              return resolve(null);
            }
            const base64 = new Buffer(data).toString('base64');
            $img.attr(
              'src',
              `data:image/svg+xml;charset=utf-8;base64,${base64}`,
            );
            return resolve(base64);
          });
        }),
      );
    }
  });

  await Promise.all(asyncFunctions);
}
