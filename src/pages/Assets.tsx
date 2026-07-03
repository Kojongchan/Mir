import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { EmptyState } from '../components/EmptyState';
import { Attachments } from '../components/Attachments';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import {
  ASSET_STATUSES,
  ASSET_STATUS_LABEL,
  assetQrPayload,
  createAsset,
  deleteAsset,
  listAssets,
  parseAssetScan,
  updateAsset,
  type Asset,
  type AssetStatus,
} from '../lib/assets';

/** R10 — QR 자재·자산 태깅. QR 부착(생성)·스캔(BarcodeDetector)·이력 조회. */
export function Assets() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const authorName = profile?.full_name ?? profile?.username ?? null;
  const [params, setParams] = useSearchParams();

  const [assets, setAssets] = useState<Asset[]>([]);
  const [openId, setOpenId] = useState<string | null>(params.get('asset'));
  const [showForm, setShowForm] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const empty = { name: '', category: '', manufacturer: '', spec: '', received_at: '', install_location: '' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 스캔 딥링크(?asset=)로 진입 시 해당 자산 펼침.
  useEffect(() => {
    const a = params.get('asset');
    if (a) setOpenId(a);
  }, [params]);

  const refresh = () =>
    listAssets(projectId)
      .then((l) => { setAssets(l); setUnavailable(false); })
      .catch(() => { setAssets([]); setUnavailable(true); });

  const onCreate = async () => {
    if (!form.name.trim()) { setMsg('자재명을 입력하세요'); return; }
    try {
      const id = await createAsset(projectId, {
        name: form.name.trim(),
        category: form.category || null,
        manufacturer: form.manufacturer || null,
        spec: form.spec || null,
        received_at: form.received_at || null,
        install_location: form.install_location || null,
      }, authorName);
      setForm(empty);
      setShowForm(false);
      await refresh();
      setOpenId(id);
      setMsg('자재 등록됨 — QR 을 출력해 부착하세요');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onScanned = (text: string) => {
    setScanning(false);
    const id = parseAssetScan(text);
    if (id) {
      setParams({ asset: id });
      setOpenId(id);
      setMsg('스캔 완료');
    } else {
      setMsg(`인식 실패: ${text.slice(0, 40)}`);
    }
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">자재·자산 (QR)</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {!unavailable && <button onClick={() => setScanning(true)}>📷 QR 스캔</button>}
          {canEdit && !unavailable && <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 자재 등록'}</button>}
        </div>
      </div>

      {unavailable && (
        <EmptyState icon="🏷" title="자재·자산 모듈이 아직 활성화되지 않았습니다" desc="마이그레이션(0039) 적용 후 QR 자산 관리를 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          {showForm && (
            <section className="card dash-edit">
              <h3>새 자재·자산</h3>
              <div className="dash-edit-row">
                <label className="grow">자재명<input value={form.name} placeholder="예: H형강 SS400" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label>종류<input value={form.category} placeholder="철골/철근/…" onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
                <label>제조사<input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} /></label>
              </div>
              <div className="dash-edit-row">
                <label>규격<input value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} /></label>
                <label>반입일<input type="date" value={form.received_at} onChange={(e) => setForm({ ...form, received_at: e.target.value })} /></label>
                <label className="grow">투입 위치<input value={form.install_location} placeholder="예: 3층 A구역" onChange={(e) => setForm({ ...form, install_location: e.target.value })} /></label>
                <button className="primary" onClick={onCreate}>등록</button>
              </div>
            </section>
          )}

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead>
                  <tr><th style={{ width: 56 }}>번호</th><th>자재명</th><th>종류</th><th>반입일</th><th>투입위치</th><th>상태</th><th /></tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <AssetRow key={a.id} asset={a} open={openId === a.id} canEdit={canEdit} projectId={projectId}
                      onToggle={() => setOpenId(openId === a.id ? null : a.id)} onChanged={refresh}
                      onDelete={async (id) => { if (window.confirm('삭제할까요?')) { await deleteAsset(id); await refresh(); } }} />
                  ))}
                  {assets.length === 0 && <tr><td colSpan={7}><EmptyState compact icon="🏷" title="등록된 자재가 없습니다" desc="자재를 등록하면 QR 이 생성됩니다." /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {scanning && <ScanModal onClose={() => setScanning(false)} onScanned={onScanned} />}
      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

function AssetRow({ asset, open, canEdit, projectId, onToggle, onChanged, onDelete }: {
  asset: Asset; open: boolean; canEdit: boolean; projectId: string;
  onToggle: () => void; onChanged: () => void; onDelete: (id: string) => void;
}) {
  return (
    <>
      <tr>
        <td className="nowrap tabular" style={{ color: 'var(--muted)', textAlign: 'center' }}>#{asset.asset_no}</td>
        <td className="cde-fname"><button className="cde-link" onClick={onToggle}>{open ? '▾ ' : '▸ '}{asset.name}</button></td>
        <td className="nowrap">{asset.category || '—'}</td>
        <td className="nowrap tabular">{asset.received_at ? formatDate(asset.received_at) : '—'}</td>
        <td className="nowrap">{asset.install_location || '—'}</td>
        <td><span className={`issue-badge asset-${asset.status}`}>{ASSET_STATUS_LABEL[asset.status]}</span></td>
        <td className="right nowrap">{canEdit && <button className="danger" onClick={() => onDelete(asset.id)}>삭제</button>}</td>
      </tr>
      {open && (
        <tr className="issue-detail-row">
          <td colSpan={7}><AssetDetail asset={asset} canEdit={canEdit} projectId={projectId} onChanged={onChanged} /></td>
        </tr>
      )}
    </>
  );
}

function AssetDetail({ asset, canEdit, projectId, onChanged }: { asset: Asset; canEdit: boolean; projectId: string; onChanged: () => void }) {
  const [qr, setQr] = useState('');
  const payload = assetQrPayload(projectId, asset.id);

  useEffect(() => {
    QRCode.toDataURL(payload, { width: 220, margin: 1 }).then(setQr).catch(() => setQr(''));
  }, [payload]);

  const onStatus = async (status: AssetStatus) => {
    await updateAsset(asset.id, { status });
    onChanged();
  };

  const downloadQr = () => {
    if (!qr) return;
    const a = document.createElement('a');
    a.href = qr;
    a.download = `asset-${asset.asset_no}-qr.png`;
    a.click();
  };

  return (
    <div className="issue-detail asset-detail">
      <div className="asset-qr">
        {qr ? <img src={qr} alt="QR" width={180} height={180} /> : <div className="skeleton" style={{ width: 180, height: 180 }} />}
        <button onClick={downloadQr}>⬇ QR 다운로드</button>
      </div>
      <div className="asset-info">
        <p className="muted issue-meta">자산 #{asset.asset_no} · 등록 {asset.created_by_name || '—'} · {formatDate(asset.created_at.slice(0, 10))}</p>
        <dl className="asset-dl">
          <div><dt>제조사</dt><dd>{asset.manufacturer || '—'}</dd></div>
          <div><dt>규격</dt><dd>{asset.spec || '—'}</dd></div>
          <div><dt>반입일</dt><dd>{asset.received_at ? formatDate(asset.received_at) : '—'}</dd></div>
          <div><dt>투입위치</dt><dd>{asset.install_location || '—'}</dd></div>
        </dl>
        {canEdit && (
          <div className="issue-assign-row">
            <label>상태
              <select value={asset.status} onChange={(e) => onStatus(e.target.value as AssetStatus)}>
                {ASSET_STATUSES.map((s) => <option key={s} value={s}>{ASSET_STATUS_LABEL[s]}</option>)}
              </select>
            </label>
          </div>
        )}
        <Attachments projectId={projectId} targetType="asset" targetId={asset.id} canEdit={canEdit} label="시험성적서·사진" />
      </div>
    </div>
  );
}

/** QR 스캐너 — 브라우저 native BarcodeDetector(무비용). 미지원 시 안내. */
function ScanModal({ onClose, onScanned }: { onClose: () => void; onScanned: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const AnyWin = window as any;
    if (!('BarcodeDetector' in window)) {
      setErr('이 브라우저는 QR 스캔(BarcodeDetector)을 지원하지 않습니다. Chrome/Edge/Android 크롬을 사용하거나 QR 링크를 직접 여세요.');
      return;
    }
    let cancelled = false;
    const detector = new AnyWin.BarcodeDetector({ formats: ['qr_code'] });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length) { onScanned(codes[0].rawValue); return; }
          } catch { /* 프레임 실패 무시 */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        setErr(`카메라 접근 실패: ${(e as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [onScanned]);

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="scan-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>QR 스캔</h3>
        {err ? (
          <p className="auth-error" style={{ fontSize: 13 }}>{err}</p>
        ) : (
          <video ref={videoRef} className="scan-video" muted playsInline />
        )}
        <div style={{ marginTop: 10, textAlign: 'right' }}><button onClick={onClose}>닫기</button></div>
      </div>
    </div>
  );
}
