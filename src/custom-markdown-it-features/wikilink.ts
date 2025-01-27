/**
 * inline [[]]
 * [[...]]
 */

import MarkdownIt from 'markdown-it';
import { Notebook } from '../notebook';

export default (md: MarkdownIt, notebook: Notebook) => {
  md.inline.ruler.before('autolink', 'wikilink', (state, silent) => {
    if (
      !notebook.config.enableWikiLinkSyntax ||
      !state.src.startsWith('[[', state.pos)
    ) {
      return false;
    }

    let content: string | null = null;
    const tag = ']]';
    let end = -1;

    let i = state.pos + tag.length;
    while (i < state.src.length) {
      if (state.src[i] === '\\') {
        i += 1;
      } else if (state.src.startsWith(tag, i)) {
        end = i;
        break;
      }
      i += 1;
    }

    if (end >= 0) {
      // found ]]
      content = state.src.slice(state.pos + tag.length, end);
    } else {
      return false;
    }

    if (content && !silent) {
      const token = state.push('wikilink', 'a', 0);
      token.content = content;

      state.pos += content.length + 2 * tag.length;
      return true;
    } else {
      return false;
    }
  });

  md.renderer.rules.wikilink = (tokens, idx) => {
    const { content } = tokens[idx];
    if (!content) {
      return '';
    }

    const splits = content.split('|');
    let link: string;
    let text: string;
    if (splits.length === 1) {
      text = splits[0].trim();

      const result = notebook.config.parserConfig.processWikiLink({
        text: text,
        link: undefined,
      });
      text = result.text;
      link = result.link;
    } else {
      if (notebook.config.useGitHubStylePipedLink) {
        const result = notebook.config.parserConfig.processWikiLink({
          text: splits[0].trim(),
          link: splits[1].trim(),
        });

        text = result.text;
        link = result.link;
      } else {
        const result = notebook.config.parserConfig.processWikiLink({
          text: splits[1].trim(),
          link: splits[0].trim(),
        });
        text = result.text;
        link = result.link;
      }
    }

    return `<a href="${link}">${text}</a>`;
  };
};
