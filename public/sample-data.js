// Sample records for the local demo, inspection mode, and the shared beta workspace seed. Sample people only.
// dateSampleProjects gives the sample projects an illustrative dated schedule (marked scheduleSource: demo).
(function (root) {
  const seed = () => ({tickets:[
{id:'JRC-1042',title:'Automate monthly sales reporting',name:'Adriane Venzon',department:'Sales',category:'New feature',date:'2026-10-30',priority:'High',status:'In progress',dev:'Miguel Santos',description:'Create a consolidated monthly sales report with department filters and an Excel export.',criteria:'Report totals match source records. Department filters work. Excel export includes all filtered rows.',project:'PRJ-1042',tasks:[{title:'Confirm report requirements',done:true},{title:'Build report and filters',done:true},{title:'Add Excel export',done:false},{title:'Internal testing',done:false}],meeting:'2026-10-19T10:00',location:'JARC meeting room',meetingConfirmed:true,notes:'Agreed on department filters and Excel export. PDF export is outside the initial scope.',history:[{text:'Project created. Requestor added as a participant.',time:'Oct 15, 10:30 AM'},{text:'Development started by Miguel Santos.',time:'Oct 16, 09:00 AM'}]},
{id:'JRC-1041',title:'Employee onboarding request form',name:'Adriane Venzon',department:'Human Resources',category:'New feature',date:'2026-11-06',priority:'Medium',status:'Assigned',dev:'Elyza Cruz',description:'Replace the manual onboarding checklist with a shared request form and approval tracking.',criteria:'',tasks:[],history:[{text:'Admin assigned Elyza Cruz.',time:'Oct 16, 08:45 AM'}]},
{id:'JRC-1040',title:'Unable to export inventory report',name:'Adriane Venzon',department:'Operations',category:'Bug / issue',date:'2026-10-20',priority:'Critical',status:'Submitted',dev:'',description:'The inventory export stops when a warehouse filter is selected. Please investigate.',criteria:'',tasks:[],history:[{text:'Ticket submitted. Admin notified.',time:'Oct 16, 08:20 AM'}]},
{id:'JRC-1039',title:'Update customer account permissions',name:'Adriane Venzon',department:'Finance',category:'Access request',date:'2026-10-22',priority:'Low',status:'Awaiting acceptance',dev:'Paolo Reyes',description:'Allow the finance team to view customer billing records.',criteria:'Finance users can view billing records without editing customer information.',project:'PRJ-1039',tasks:[{title:'Update permission rules',done:true},{title:'Verify access boundaries',done:true}],history:[{text:'Internal testing passed. Requestor review requested.',time:'Oct 15, 03:30 PM'}]},
{id:'JRC-1038',title:'Refresh purchase approval workflow',name:'Adriane Venzon',department:'Procurement',category:'Enhancement',date:'2026-10-28',priority:'Medium',status:'Planning',dev:'Miguel Santos',description:'Add a second approval step for high-value purchase requests.',criteria:'Purchases over the agreed threshold require two approvals.',project:'PRJ-1038',tasks:[{title:'Document approval rules',done:true},{title:'Implement second approval',done:false},{title:'Test approval routing',done:false}],history:[{text:'Scope confirmed and project item created.',time:'Oct 15, 11:00 AM'}]},
{id:'JRC-1037',title:'Fix duplicate customer notifications',name:'Adriane Venzon',department:'Customer Service',category:'Bug / issue',date:'2026-10-15',priority:'Medium',status:'Closed',dev:'Elyza Cruz',description:'Prevent duplicate notifications when a customer record is saved.',criteria:'Only one notification is delivered per save.',project:'PRJ-1037',tasks:[{title:'Fix event handling',done:true},{title:'Test and release',done:true}],history:[{text:'Requestor accepted delivery. Released and closed.',time:'Oct 15, 04:00 PM'}]}
],changes:[{id:'CR-201',ticket:'JRC-1042',title:'Add PDF export to sales reports',reason:'Managers need a printable report for monthly meetings.',status:'Submitted',impact:'',criteria:'PDF includes selected department and reporting period.',history:[{text:'Change request submitted for admin review.',time:'Oct 16, 10:00 AM'}]}],notices:[{text:'JRC-1040 · New inventory export issue is awaiting review.',time:'Oct 16, 08:20 AM'},{text:'JRC-1039 · Delivery is ready for requestor acceptance.',time:'Oct 15, 03:30 PM'},{text:'CR-201 · PDF export change request submitted.',time:'Oct 16, 10:00 AM'}]});

  // Illustrative schedule for sample projects only; real records keep their own dates.
  function dateSampleProjects(state, TL) {
    state.tickets.filter(t => t.project).forEach(t => {
      t.projectName = t.title;
      t.requirements = t.notes || t.description;
      const end = TL.day(t.date);
      t.tasks.forEach((task, i) => {
        task.start = TL.date(end - (t.tasks.length - i) * 3 * TL.DAY);
        task.end = TL.date(end - (t.tasks.length - i - 1) * 3 * TL.DAY - TL.DAY);
        task.requirement = task.title;
        task.criteria = 'Demonstrate this task against the agreed project acceptance criteria.';
        task.owner = t.dev;
        task.scheduleSource = 'demo';
      });
    });
    return state;
  }

  const api = { seed, dateSampleProjects };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SampleData = api;
})(typeof window !== 'undefined' ? window : globalThis);
