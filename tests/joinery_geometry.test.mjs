import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSolids, emptyDesign, compileDesign } from '../viewer/design.js';
import { buildArchetype } from '../viewer/archetypes.js';
import { resolvedJoints, jointKey } from '../viewer/autojoints.js';
const volume = (s) => Math.abs(s.faces.reduce((sum, [ia,ib,ic]) => {
  const [a,b,c] = [ia,ib,ic].map((i) => s.positions[i]);
  return sum + (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
},0));
const part = (id,size,at,along='x',up='y') => ({ id, name:id, material:'Maple', size, instances:[{at,along,up}] });
const fixture = () => ({ ...emptyDesign(), parts: [part('rail',[10,2,0.75],[0,5,0]), part('post',[12,3,3],[6.5,6,0],'y','z')] });
test('contact infers a tenon and removes the matching mortise volume; moving away removes both', () => {
  const d = fixture(); const j = resolvedJoints(d);
  assert.equal(j.length,1); assert.equal(j[0].type,'mortise-tenon');
  const [rail,post] = buildSolids(d), t = rail.tenons[1];
  assert.ok(Math.abs(volume(rail)-(15+t.width*t.thickness*t.length))<1e-5);
  assert.ok(Math.abs(volume(post)-(108-t.width*t.thickness*t.length))<1e-5);
  assert.equal(post.socketCount,1);
  d.parts[0].instances[0].at[0] -= 2;
  assert.equal(resolvedJoints(d).length,0);
  assert.ok(Math.abs(volume(buildSolids(d)[1])-108)<1e-5);
});
test('joint choice regenerates dovetail geometry and matching socket without moving stock', () => {
  const d = fixture(), j = resolvedJoints(d)[0], before=structuredClone(d.parts);
  d.jointChoices = { [jointKey(j)]:'dovetail' };
  const [rail,post]=buildSolids(d);
  assert.ok(rail.tenons[1].dovetail);
  assert.deepEqual(d.parts,before);
  assert.ok(volume(rail)+volume(post)<123, 'sliding groove opens across receiver for assembly');
  assert.ok(volume(post)<108);
  d.jointChoices[jointKey(j)]='none';
  assert.ok(Math.abs(volume(buildSolids(d)[1])-108)<1e-5);
});
test('bookcase dados and table mortises remove real wood; tilted round tenons have circular ends', () => {
  for (const key of ['bookcase','dining-table']) {
    const solids=buildSolids(buildArchetype(key));
    const receivers=solids.filter((s)=>s.socketCount);
    assert.ok(receivers.length>0);
    receivers.forEach((s)=>assert.ok(volume(s)<s.part.size.reduce((a,b)=>a*b,1)));
  }
  const stool=buildSolids(buildArchetype('stool'));
  assert.ok(stool.find((s)=>s.part.id==='seat').socketCount>0);
  const leg=stool.find((s)=>s.part.id==='leg');
  assert.ok(leg.faces.length>100);
  assert.ok(volume(leg)>0);
});
test('crossing rails receive complementary half-laps', () => {
  const d={...emptyDesign(),parts:[part('a',[12,2,1],[0,2,0]),part('b',[12,2,1],[0,2,0],'z')]};
  assert.equal(resolvedJoints(d)[0].type,'half-lap');
  const solids=buildSolids(d);
  solids.forEach((s)=>assert.ok(Math.abs(volume(s)-22)<1e-5));
});
test('instance-specific automatic joints produce separate cut lengths', () => {
  const d=fixture(); d.parts[0].instances.push({at:[0,5,8],along:'x',up:'y'});
  const rows=JSON.parse(compileDesign(d).files['parts_report.json']).filter((r)=>r.label==='rail');
  assert.equal(rows.length,2); assert.notEqual(rows[0].dims[0],rows[1].dims[0]);
});

test('cut receivers form closed shells without T-junctions', () => {
  const solids=buildSolids(fixture());
  for(const solid of solids.filter((s)=>s.socketCount)) {
    const counts=new Map();
    const key=(i)=>solid.positions[i].map((v)=>Math.round(v*1e5)).join(',');
    for(const face of solid.faces) for(let i=0;i<3;i++) {
      const edge=[key(face[i]),key(face[(i+1)%3])].sort().join('|');
      counts.set(edge,(counts.get(edge)||0)+1);
    }
    assert.ok([...counts.values()].every((n)=>n===2));
  }
});
test('switching a seated dado to a tenon changes the shoulder, not the placement', () => {
  const d=buildArchetype('bookcase'), joints=resolvedJoints(d), j=joints.find((q)=>q.from==='shelf' && q.end===0);
  const original=structuredClone(d.parts);
  d.jointChoices={[jointKey(j)]:'mortise-tenon'};
  const shelf=buildSolids(d).find((s)=>s.part.id==='shelf');
  assert.equal(shelf.tenons[0].inset,0.25);
  assert.deepEqual(d.parts,original);
  const f=fixture(), auto=resolvedJoints(f)[0]; f.jointChoices={[jointKey(auto)]:'dado'};
  const [rail,post]=buildSolids(f);
  assert.ok(rail.extents[0]>10);
  assert.ok(post.socketCount>0);
});
