// MIR_VDC 브랜드 마크 — 로고 색(MIR 회색 + VDC 빨강) + 앞에 SS 마크.
// SS 마크는 공식 로고를 근사한 인라인 SVG(회색 S 뒤 + 빨강 S 앞 겹침).
// 색은 --brand-gray / --brand-red 토큰을 따른다(라이트·다크 공통).

interface Props {
  /** lg: 로그인 · md: 프로젝트 선택 · sm: 상단바/헤더 */
  size?: 'sm' | 'md' | 'lg';
}

export function BrandLogo({ size = 'sm' }: Props) {
  return (
    <span className={`brand-logo brand-logo-${size}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 35 34" role="img" aria-label="SS">
          <text
            className="brand-s brand-s-gray"
            x="1"
            y="27"
            fontSize="34"
            fontWeight="800"
          >
            S
          </text>
          <text
            className="brand-s brand-s-red"
            x="15"
            y="27"
            fontSize="34"
            fontWeight="800"
          >
            S
          </text>
        </svg>
      </span>
      <span className="brand-word">
        <span className="brand-mir">MIR</span>
        <span className="brand-vdc">VDC</span>
      </span>
    </span>
  );
}
