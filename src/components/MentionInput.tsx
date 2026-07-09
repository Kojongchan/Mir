import { useRef, useState } from 'react';

export interface MentionMember {
  id: string;
  name: string;
  company?: string | null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  members: MentionMember[];
  /** 본문에 실제로 남아 있는 @이름 을 사용자 id 로 해석해 알려준다(입력·삭제 반영). */
  onMentionsChange: (ids: string[]) => void;
  onEnter?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

/** 이름이 경계(공백/문장부호/끝) 로 끝나는 `@이름` 만 멘션으로 인정. 부분일치 오탐 방지. */
export function mentionsInText(text: string, members: MentionMember[]): string[] {
  const ids: string[] = [];
  for (const m of members) {
    const needle = '@' + m.name;
    let from = 0;
    let hit = false;
    while (true) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const after = text[at + needle.length];
      // 뒤 문자가 이름의 일부가 아닌 경계면 멘션으로 인정.
      if (after === undefined || /[\s.,!?)\]}·]/.test(after)) {
        hit = true;
        break;
      }
      from = at + needle.length;
    }
    if (hit) ids.push(m.id);
  }
  return ids;
}

/**
 * @멘션 자동완성 입력. `@` 를 치면 현재 프로젝트 구성원이 아래 목록에 뜨고, `@관` 처럼
 * 이어 치면 이름으로 좁혀진다. 선택하면 `@이름 ` 이 삽입되고, 그냥 이름을 직접 쳐도 된다.
 * 실제 남아 있는 @이름 을 사용자 id 로 해석해 onMentionsChange 로 알린다.
 */
export function MentionInput({ value, onChange, members, onMentionsChange, onEnter, placeholder, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(false);
  const [hi, setHi] = useState(0);

  // 커서 앞의 활성 @토큰(마지막 '@' ~ 커서). 이름 경계 규칙에 따라 후보를 좁힌다.
  const token = (() => {
    const pre = value.slice(0, caret);
    const at = pre.lastIndexOf('@');
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(pre[at - 1])) return null; // 단어 중간의 @ 무시
    const q = pre.slice(at + 1);
    if (q.includes('\n')) return null;
    return { at, q };
  })();

  const matches =
    active && token
      ? members.filter((m) => token.q === '' || m.name.toLowerCase().includes(token.q.toLowerCase())).slice(0, 8)
      : [];
  const showList = matches.length > 0;

  const emit = (v: string) => {
    onChange(v);
    onMentionsChange(mentionsInText(v, members));
  };

  const onType = (e: React.ChangeEvent<HTMLInputElement>) => {
    setActive(true);
    setHi(0);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    emit(e.target.value);
  };

  const pick = (m: MentionMember) => {
    if (!token) return;
    const next = value.slice(0, token.at) + '@' + m.name + ' ' + value.slice(caret);
    const pos = token.at + m.name.length + 2; // '@' + name + ' '
    emit(next);
    setActive(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showList) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHi((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[hi] ?? matches[0]);
        return;
      }
      if (e.key === 'Escape') {
        setActive(false);
        return;
      }
    }
    if (e.key === 'Enter') onEnter?.();
  };

  const syncCaret = () => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  };

  return (
    <div className="mention-input">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onType}
        onKeyDown={onKey}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onBlur={() => setTimeout(() => setActive(false), 120)}
      />
      {showList && (
        <ul className="mention-list" role="listbox">
          {matches.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'is-hi' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="mention-name">@{m.name}</span>
              {m.company && <span className="mention-company">{m.company}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
