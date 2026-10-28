import tokens from './styles/tokens.css' with { type: 'text' };
import base from './styles/base.css' with { type: 'text' };
import actions from './components/actions/actions.css' with { type: 'text' };
import feedback from './components/feedback/feedback.css' with { type: 'text' };
import forms from './components/forms/forms.css' with { type: 'text' };
import layout from './components/layout/layout.css' with { type: 'text' };
import data from './components/data/data.css' with { type: 'text' };
import photo from './components/photo/photo.css' with { type: 'text' };

/** Tokens alone, for pages that bring their own components. */
export const TOKENS_CSS: string = tokens;

/** The whole design system as one stylesheet, ready to inline in a <style>. */
export const UI_CSS: string = [tokens, base, actions, feedback, forms, layout, data, photo].join('\n');
