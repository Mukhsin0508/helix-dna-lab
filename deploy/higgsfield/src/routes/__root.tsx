import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, HeadContent, Scripts } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import appCss from '../styles.css?url';
import { reportHiggsfieldError } from '../lib/higgsfield-error-reporting';
import meta from '../app-meta.json';
declare const __HF_DESIGN_INSPECTOR__: boolean;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: meta.og_title },
      { name: 'description', content: meta.og_description },
      { property: 'og:title', content: meta.og_title },
      { property: 'og:description', content: meta.og_description },
      { property: 'og:type', content: 'website' },
      { property: 'og:image', content: 'https://helix-dna-lab.higgsfield.app' + meta.og_image_url },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }, { rel: 'icon', href: meta.favicon_url }],
  }),
  shellComponent: Shell,
  component: Root,
  notFoundComponent: () => <main style={{padding:'12vh 8vw'}}><h1>Page not found</h1><a href="/">Open Helix</a></main>,
  errorComponent: ({reset}) => <main style={{padding:'12vh 8vw'}}><h1>The lab couldn’t load</h1><button onClick={reset}>Try again</button></main>,
});
function Shell({children}:{children:ReactNode}) {
  return <html lang="en" style={{colorScheme:'light'}}><head><HeadContent /></head><body>{children}<Scripts /></body></html>;
}
function Root() {
  const {queryClient} = Route.useRouteContext();
  useEffect(() => {
    if (!__HF_DESIGN_INSPECTOR__) return;
    void import('../module/design-inspector/runtime').then(m => m.installHiggsfieldDesignInspector()).catch(error => reportHiggsfieldError(error,{boundary:'design_inspector'}));
  }, []);
  return <QueryClientProvider client={queryClient}><Outlet /></QueryClientProvider>;
}
