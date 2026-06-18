// MIR SMART 브랜드 마크 — 공식 SS 로고 이미지 + MIR(회색)/SMART(빨강) 워드마크.
// 색은 --brand-gray / --brand-red 토큰을 따른다(라이트·다크 공통).

interface Props {
  /** lg: 로그인 · md: 프로젝트 선택 · sm: 상단바/헤더 */
  size?: 'sm' | 'md' | 'lg';
}

export function BrandLogo({ size = 'sm' }: Props) {
  return (
    <span className={`brand-logo brand-logo-${size}`}>
      <img className="brand-mark-img" src="/brand/ss-logo.png" alt="" aria-hidden="true" />
      <span className="brand-word">
        <span className="brand-mir">MIR</span>
        <span className="brand-smart">SMART</span>
      </span>
    </span>
  );
}
