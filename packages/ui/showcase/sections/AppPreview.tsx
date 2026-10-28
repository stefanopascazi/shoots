/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import {
  Badge,
  Button,
  Content,
  Filmstrip,
  IconButton,
  NavItem,
  PageHeader,
  PhotoGrid,
  PhotoTile,
  Segmented,
  Sidebar,
  SidebarSection,
  StarRating,
  Topbar,
  type PhotoFlag,
} from '../../src/index.js';
import { fakePhoto } from '../fakePhotos.js';
import { Section } from '../Section.js';

interface Photo {
  name: string;
  rating: number;
  flag?: PhotoFlag;
}

const INITIAL: Photo[] = [
  { name: 'IMG_4102.CR3', rating: 4, flag: 'pick' },
  { name: 'IMG_4103.CR3', rating: 3 },
  { name: 'IMG_4104.CR3', rating: 0, flag: 'rejected' },
  { name: 'IMG_4107.CR3', rating: 5, flag: 'pick' },
  { name: 'IMG_4110.CR3', rating: 2 },
  { name: 'IMG_4111.CR3', rating: 3 },
  { name: 'IMG_4115.CR3', rating: 1, flag: 'rejected' },
  { name: 'IMG_4118.CR3', rating: 4 },
];

/** A whole screen built only from design-system parts: what the local app will look like. */
export function AppPreview() {
  const [photos, setPhotos] = useState(INITIAL);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'grid' | 'strip'>('grid');
  const current = photos[selected];
  const setRating = (rating: number) => setPhotos((ps) => ps.map((p, i) => (i === selected ? { ...p, rating } : p)));

  const tiles = photos.map((p, i) => (
    <PhotoTile src={fakePhoto(i)} name={p.name} rating={p.rating} flag={p.flag} selected={i === selected} onClick={() => setSelected(i)} />
  ));

  return (
    <Section id="app" title="In context" description="A full screen assembled from the parts above — the shape of the local web app.">
      <div class="sc-frame">
        <div class="sh-app sc-frame__app">
          <Sidebar meta="0.8.0" footer={<NavItem icon="settings">Settings</NavItem>}>
            <NavItem icon="grid" active count={664}>
              Library
            </NavItem>
            <NavItem icon="sparkle">Train</NavItem>
            <NavItem icon="sliders">Calibrate</NavItem>
            <NavItem icon="eye">Review</NavItem>
            <SidebarSection>Shoots</SidebarSection>
            <NavItem icon="folder" count={212}>
              Wedding — Lecce
            </NavItem>
            <NavItem icon="folder" count={98}>
              Portraits Oct
            </NavItem>
          </Sidebar>
          <div class="sh-main">
            <Topbar title="Library">
              <Badge tone="success" dot>
                Lightroom connected
              </Badge>
              <span class="sh-spacer" />
              <Segmented
                label="View"
                value={view}
                onChange={setView}
                options={[
                  { value: 'grid', label: 'Grid', icon: 'grid' },
                  { value: 'strip', label: 'Loupe', icon: 'image' },
                ]}
              />
              <IconButton icon="search" label="Search" />
            </Topbar>
            <Content>
              <PageHeader
                eyebrow="Wedding — Lecce · 212 photos"
                title="Library"
                description="Ratings and flags from the last run. Changes go back to Lightroom through the plug-in."
                actions={
                  <>
                    <Button icon="refresh">Re-run</Button>
                    <Button variant="primary" icon="upload">
                      Apply to Lightroom
                    </Button>
                  </>
                }
              />
              {view === 'grid' ? (
                <PhotoGrid thumb={170}>{tiles}</PhotoGrid>
              ) : (
                <div class="sh-stack">
                  <div class="sc-loupe">
                    <img src={fakePhoto(selected, 900, 600)} alt={current.name} />
                  </div>
                  <div class="sh-row">
                    <strong>{current.name}</strong>
                    <StarRating value={current.rating} onChange={setRating} size={18} />
                    <span class="sh-spacer" />
                    <IconButton icon="chevron-left" label="Previous" variant="secondary" onClick={() => setSelected((s) => Math.max(0, s - 1))} />
                    <IconButton icon="chevron-right" label="Next" variant="secondary" onClick={() => setSelected((s) => Math.min(photos.length - 1, s + 1))} />
                  </div>
                  <Filmstrip thumb={96}>{tiles}</Filmstrip>
                </div>
              )}
            </Content>
          </div>
        </div>
      </div>
    </Section>
  );
}
