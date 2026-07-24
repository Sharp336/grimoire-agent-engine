<ctx-search-hint generation="{{generation}}">
{{#each fragments}}
<fragment source="{{source}}" id="{{id}}" score="{{score}}"{{#if tags}} tags="{{tags}}"{{/if}}>
{{snippet}}
</fragment>
{{/each}}
</ctx-search-hint>
