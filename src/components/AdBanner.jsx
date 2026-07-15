import React, { useEffect, useRef } from 'react';

const AD_CLIENT = 'ca-pub-XXXXXXXXXXXXXXXX';

const AD_SLOTS = {
  banner:      '1234567890',
  responsive:  '1234567891',
  sidebar:     '1234567892',
};

function AdBanner({ type = 'banner', style = {}, className = '' }) {
  const adRef = useRef(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch (e) {
      console.warn('[AdSense] push error:', e);
    }
  }, []);

  if (type === 'banner') {
    return (
      <div className={`ad-banner ${className}`} style={{
        margin: '12px 0',
        borderRadius: '8px',
        overflow: 'hidden',
        background: 'rgba(15,23,42,0.4)',
        border: '1px solid rgba(51,65,85,0.3)',
        textAlign: 'center',
        minHeight: '90px',
        ...style
      }}>
        <ins
          ref={adRef}
          className="adsbygoogle"
          style={{ display: 'block' }}
          data-ad-client={AD_CLIENT}
          data-ad-slot={AD_SLOTS.banner}
          data-ad-format="horizontal"
          data-full-width-responsive="true"
        />
      </div>
    );
  }

  if (type === 'responsive') {
    return (
      <div className={`ad-responsive ${className}`} style={{
        margin: '16px 0',
        borderRadius: '8px',
        overflow: 'hidden',
        background: 'rgba(15,23,42,0.4)',
        border: '1px solid rgba(51,65,85,0.3)',
        textAlign: 'center',
        minHeight: '250px',
        ...style
      }}>
        <ins
          ref={adRef}
          className="adsbygoogle"
          style={{ display: 'block' }}
          data-ad-client={AD_CLIENT}
          data-ad-slot={AD_SLOTS.responsive}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </div>
    );
  }

  if (type === 'sidebar') {
    return (
      <div className={`ad-sidebar ${className}`} style={{
        margin: '10px 0',
        borderRadius: '6px',
        overflow: 'hidden',
        background: 'rgba(15,23,42,0.4)',
        border: '1px solid rgba(51,65,85,0.3)',
        textAlign: 'center',
        minHeight: '250px',
        ...style
      }}>
        <ins
          ref={adRef}
          className="adsbygoogle"
          style={{ display: 'block' }}
          data-ad-client={AD_CLIENT}
          data-ad-slot={AD_SLOTS.sidebar}
          data-ad-format="vertical"
          data-full-width-responsive="true"
        />
      </div>
    );
  }

  return null;
}

export default AdBanner;
