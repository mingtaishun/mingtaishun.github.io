var e=Object.freeze({"page-mode":`pageMode`,orientation:`orientation`,"portrait-rotation":`portraitRotation`,"initial-page":`initialPage`,"link-delay":`linkDelay`});function t(t){let n=t.getAttribute(`src`);if(!n)return``;let r=new URL(n,document.baseURI);for(let[n,i]of Object.entries(e)){let e=t.getAttribute(n);e!==null&&e!==``&&r.searchParams.set(i,e)}return r.href}var n=class extends HTMLElement{static observedAttributes=[`src`,`title`,`loading`,...Object.keys(e)];constructor(){super(),this.attachShadow({mode:`open`});let e=document.createElement(`style`);e.textContent=`
      :host {
        display: block;
        width: 100%;
        min-height: 28rem;
        height: var(--danny-flip-height, min(82vh, 60rem));
        background: #101820;
        overflow: hidden;
        contain: layout paint style;
      }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
    `,this.iframe=document.createElement(`iframe`),this.iframe.allow=`fullscreen`,this.iframe.setAttribute(`allowfullscreen`,``),this.shadowRoot.append(e,this.iframe)}connectedCallback(){this.sync()}attributeChangedCallback(){this.isConnected&&this.sync()}sync(){let e=t(this);if(!e){this.iframe.removeAttribute(`src`);return}this.iframe.src=e,this.iframe.title=this.getAttribute(`title`)||`Interactive document`,this.iframe.loading=this.getAttribute(`loading`)===`eager`?`eager`:`lazy`}};customElements.get(`danny-flip`)||customElements.define(`danny-flip`,n);