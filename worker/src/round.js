/* 판의 수명 판단 (§3.4). 알람은 시각을 조작하기 어려워서, 판단만 순수 함수로 떼어 둡니다 —
   시험(test-api.mjs)이 이 함수를 그대로 부릅니다.
   워커의 진입 모듈은 함수 아닌 이름을 내보낼 수 없어서 파일을 따로 둡니다. */

/* 계정 붙은 자리가 있는 판만 무활동 24시간이면 얼립니다. 혼자 판은 영구입니다 —
   세던 판이 사라지면 안 되니까요. 로비 6시간 자동 닫힘은 폐기했습니다 (§1) */
export const PAUSE_IDLE_MS = 24 * 3600 * 1000;
/* 판만 지웁니다 — 방·멤버십은 남습니다 */
export const STATE_IDLE_MS = 90 * 86400 * 1000;

/* seated = "계정이 붙은 자리(st ok)가 하나라도 있는가". 0 이면 걸 알람이 없습니다 */
/* (폐기 2026-09-05, §3.4) 자동 중단 — 방장 앱이 없으면 자수는 이미 잠기고(scribeOn=false),
   오버레이에 옛 판이 남는 것은 "판을 언제 닫을지는 방장이 정한다"가 받아들인 일이라 근거가
   사라졌다. 판단 함수는 시험이 부르므로 이름은 남기고 언제나 0(알람 없음)을 돌려준다 */
export const autoPauseAt = () => 0;

export const shouldAutoPause = ({ stateAt, paused, seated, now }) => {
  const at = autoPauseAt({ stateAt, paused, seated });
  return !!at && at <= now;
};

/* 알람 하나가 다음 만료 시각을 관리합니다 — 자동 중단 24시간과 판 삭제 90일이 같이 삽니다 */
export const nextRoomAlarm = ({ stateAt, paused, seated }) => {
  let at = autoPauseAt({ stateAt, paused, seated });
  if (stateAt) {
    const t = stateAt + STATE_IDLE_MS;
    if (!at || t < at) at = t;
  }
  return at;
};
